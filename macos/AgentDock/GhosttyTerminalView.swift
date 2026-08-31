import AppKit
import Foundation
import GhosttyKit
import SwiftUI
import UniformTypeIdentifiers

struct GhosttyTerminalView: NSViewRepresentable {
    @EnvironmentObject private var model: AppModel
    let session: AgentSession

    func makeNSView(context: Context) -> TerminalHostView {
        TerminalHostView(surfaceView: model.terminals.view(for: session))
    }

    func updateNSView(_ host: TerminalHostView, context: Context) {
        host.surfaceView.setVisible(true)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: TerminalHostView, context: Context) -> CGSize {
        proposal.replacingUnspecifiedDimensions(by: nsView.bounds.size)
    }

    static func dismantleNSView(_ host: TerminalHostView, coordinator: ()) {
        host.surfaceView.setVisible(false)
    }
}

/// Plain container so SwiftUI's own layer management never touches the surface view.
/// libghostty owns the surface view's backing layer and replacing it kills rendering.
@MainActor
final class TerminalHostView: NSView {
    let surfaceView: GhosttySurfaceView

    private let dropOverlay = TerminalDropOverlay()
    private var scrollCatcher: TerminalScrollCatcher?

    init(surfaceView: GhosttySurfaceView) {
        self.surfaceView = surfaceView
        super.init(frame: .zero)
        setContentHuggingPriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.defaultLow, for: .vertical)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        registerForDraggedTypes(SessionFileDrop.pasteboardTypes)
        surfaceView.autoresizingMask = [.width, .height]
        surfaceView.dropHost = self
        surfaceView.removeFromSuperview()
        addSubview(surfaceView)
        let catcher = TerminalScrollCatcher()
        catcher.surfaceView = surfaceView
        catcher.autoresizingMask = [.width, .height]
        addSubview(catcher)
        addSubview(dropOverlay)
        surfaceView.frame = bounds
        catcher.frame = bounds
        dropOverlay.frame = bounds
        dropOverlay.autoresizingMask = [.width, .height]
        dropOverlay.isHidden = true
        scrollCatcher = catcher
    }

    required init?(coder: NSCoder) {
        nil
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }

    override func layout() {
        super.layout()
        surfaceView.frame = bounds
        scrollCatcher?.frame = bounds
        dropOverlay.frame = bounds
        surfaceView.syncToHost()
    }

    func setDropTargeted(_ on: Bool) {
        dropOverlay.isHidden = !on
        if on { dropOverlay.frame = bounds }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        SessionFileDrop.entered(sender, host: self)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        SessionFileDrop.entered(sender, host: self)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        setDropTargeted(false)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        !SessionFileDrop.urls(from: sender).isEmpty
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        setDropTargeted(false)
        return surfaceView.insertDroppedFiles(SessionFileDrop.urls(from: sender))
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        window?.makeFirstResponder(surfaceView)
    }

    override func scrollWheel(with event: NSEvent) {
        surfaceView.scrollWheel(with: event)
    }
}

/// Surfaces live as long as the app does, keyed by session, so switching tabs or
/// sessions never tears down a running terminal.
@MainActor
final class TerminalSurfaceStore {
    private var views: [String: GhosttySurfaceView] = [:]

    func view(for session: AgentSession) -> GhosttySurfaceView {
        if let existing = views[session.id] {
            return existing
        }
        let view = GhosttySurfaceView(session: session)
        views[session.id] = view
        return view
    }

    func remove(sessionID: String) {
        guard let view = views.removeValue(forKey: sessionID) else { return }
        view.shutdown()
        view.removeFromSuperview()
    }
}

@MainActor
final class GhosttySurfaceView: NSView, @preconcurrency NSTextInputClient {
    let session: AgentSession
    private(set) var surface: ghostty_surface_t?

    private var visible = true
    private var revealing = false
    private var revealed = false
    private var revealTask: Task<Void, Never>?
    private var resizeWindowTask: Task<Void, Never>?
    private var scrollFlushTask: Task<Void, Never>?
    private var pendingScrollLines = 0
    private var pendingScrollRemainder = 0.0
    private var scrollMonitor: Any?
    private var lockedGrid: TmuxClient.Size?
    private var lastBacking = CGSize.zero
    private var windowObservers: [NSObjectProtocol] = []
    private var configObserver: NSObjectProtocol?
    private var markedText = NSMutableAttributedString()
    private var keyTextAccumulator: [String]?
    private var loggedSize = false
    weak var dropHost: TerminalHostView?

    init(session: AgentSession) {
        self.session = session
        super.init(frame: .zero)
        registerForDraggedTypes(SessionFileDrop.pasteboardTypes)
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self else { return event }
            return MainActor.assumeIsolated {
                self.consumeScroll(event)
            }
        }
        configObserver = NotificationCenter.default.addObserver(
            forName: GhosttyRuntime.configDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.applyGhosttyConfig()
            }
        }
    }

    required init?(coder: NSCoder) {
        nil
    }

    deinit {
        if let surface {
            ghostty_surface_free(surface)
        }
    }

    override var acceptsFirstResponder: Bool { true }

    override var isOpaque: Bool { true }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }

    // MARK: Lifecycle

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeWindowObservers()
        guard let window else { return }
        createSurfaceIfNeeded()
        syncDisplayID()
        syncSize()
        observeWindow(window)
    }

    override func layout() {
        super.layout()
        createSurfaceIfNeeded()
        syncSize()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        createSurfaceIfNeeded()
        syncSize()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        if let window {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer?.contentsScale = window.backingScaleFactor
            CATransaction.commit()
        }
        syncSize()
    }

    override func updateTrackingAreas() {
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .mouseMoved, .inVisibleRect, .activeAlways],
            owner: self,
            userInfo: nil
        ))
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        SessionFileDrop.entered(sender, host: dropHost)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        SessionFileDrop.entered(sender, host: dropHost)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        dropHost?.setDropTargeted(false)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        !SessionFileDrop.urls(from: sender).isEmpty
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        dropHost?.setDropTargeted(false)
        return insertDroppedFiles(SessionFileDrop.urls(from: sender))
    }

    @discardableResult
    func insertDroppedFiles(_ urls: [URL]) -> Bool {
        let text = SessionFileDrop.input(from: urls)
        guard surface != nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
        return true
    }

    func setVisible(_ visible: Bool) {
        self.visible = visible
        guard let surface, !revealing else { return }
        // The flag is "visible", not "occluded": passing the wrong polarity stops
        // the renderer from drawing at all.
        ghostty_surface_set_occlusion(surface, visible)
        if visible {
            syncSize()
            ghostty_surface_refresh(surface)
        }
    }

    /// Host layout can set `frame` to a size we already recorded without
    /// Ghostty or tmux ever being told. Compare the live surface, not just
    /// the last backing we stored.
    func syncToHost() {
        syncSize()
    }

    func shutdown() {
        revealTask?.cancel()
        revealTask = nil
        resizeWindowTask?.cancel()
        resizeWindowTask = nil
        scrollFlushTask?.cancel()
        scrollFlushTask = nil
        pendingScrollLines = 0
        pendingScrollRemainder = 0
        if let scrollMonitor {
            NSEvent.removeMonitor(scrollMonitor)
            self.scrollMonitor = nil
        }
        removeWindowObservers()
        if let configObserver {
            NotificationCenter.default.removeObserver(configObserver)
            self.configObserver = nil
        }
        revealing = false
    }

    private func applyGhosttyConfig() {
        guard let surface else { return }
        GhosttyRuntime.shared.applyConfig(to: surface)
    }

    private func createSurfaceIfNeeded() {
        guard surface == nil else { return }
        guard window != nil, bounds.width > 1, bounds.height > 1 else { return }
        if let host = superview, host.bounds.width > 1, abs(bounds.width - host.bounds.width) > 1 {
            return
        }

        TmuxClient.configure(session.name)
        let tmuxSize = TmuxClient.measureWindow(session.name)?.clamped
        lockedGrid = tmuxSize
        surface = GhosttyRuntime.shared.createSurface(in: self, session: session)
        GhosttyLog.write(
            "surface create name=\(session.name) ok=\(surface != nil) " +
                "runtimeError=\(GhosttyRuntime.shared.initializationError ?? "none") " +
                "bounds=\(bounds.size) tmux=\(tmuxSize.map { "\($0.cols)x\($0.rows)" } ?? "none") " +
                "layer=\(String(describing: layer.map { type(of: $0) }))"
        )
        guard let surface else { return }

        revealing = true
        ghostty_surface_set_focus(surface, window?.firstResponder === self)
        ghostty_surface_set_occlusion(surface, false)
        applyLockedGrid()
        syncDisplayID()
        revealAfterAttach()
    }

    private func revealAfterAttach() {
        revealTask?.cancel()
        revealTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(80))
            guard let self, !Task.isCancelled, let surface = self.surface else { return }
            self.revealing = false
            self.revealed = true
            self.lastBacking = .zero
            self.syncSize()
            ghostty_surface_set_occlusion(surface, self.visible)
            if self.visible {
                ghostty_surface_refresh(surface)
            }
            GhosttyLog.write(
                "surface reveal name=\(self.session.name) " +
                    "grid=\(self.lockedGrid.map { "\($0.cols)x\($0.rows)" } ?? "none")"
            )
        }
    }

    private func applyLockedGrid() {
        guard let surface else { return }
        applyContentScale()
        guard let grid = lockedGrid else { return }
        _ = ghostty_surface_set_grid_size(surface, UInt16(grid.cols), UInt16(grid.rows), nil)
    }

    private func applyContentScale() {
        guard let surface, bounds.width > 1, bounds.height > 1 else { return }
        let backing = convertToBacking(bounds)
        ghostty_surface_set_content_scale(surface, backing.width / bounds.width, backing.height / bounds.height)
    }

    private func syncSize() {
        guard let surface, bounds.width > 1, bounds.height > 1 else { return }
        applyContentScale()
        // Attach must not adopt the view: that SIGWINCHes the agent. After
        // the first paint, the view is the size the user chose — including
        // maximize / full screen — so Ghostty and tmux follow it.
        if !revealed {
            applyLockedGrid()
            return
        }

        let backing = convertToBacking(bounds)
        let next = CGSize(width: backing.width.rounded(), height: backing.height.rounded())
        guard next.width > 1, next.height > 1 else { return }
        let applied = ghostty_surface_size(surface)
        let alreadyFit =
            lastBacking == next
            && applied.width_px == UInt32(next.width)
            && applied.height_px == UInt32(next.height)
        guard !alreadyFit else {
            let grid = TmuxClient.Size(cols: Int(applied.columns), rows: Int(applied.rows)).clamped
            if grid != lockedGrid {
                scheduleTmuxResize()
            }
            return
        }
        lastBacking = next
        ghostty_surface_set_size(surface, UInt32(next.width), UInt32(next.height))
        scheduleTmuxResize()

        if GhosttyLog.enabled, !loggedSize {
            loggedSize = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, let surface = self.surface else { return }
                let size = ghostty_surface_size(surface)
                GhosttyLog.write(
                    "surface state name=\(self.session.name) grid=\(size.columns)x\(size.rows) " +
                        "px=\(size.width_px)x\(size.height_px) " +
                        "layer=\(String(describing: self.layer.map { type(of: $0) })) " +
                        "sublayers=\(self.layer?.sublayers?.count ?? 0) " +
                        "opaque=\(self.layer?.isOpaque ?? false) " +
                        "hidden=\(self.isHidden) window=\(self.window != nil)"
                )
            }
        }
    }

    private func scheduleTmuxResize() {
        resizeWindowTask?.cancel()
        resizeWindowTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard let self, !Task.isCancelled, let surface = self.surface else { return }
            let size = ghostty_surface_size(surface)
            guard size.columns > 1, size.rows > 1 else { return }
            let next = TmuxClient.Size(cols: Int(size.columns), rows: Int(size.rows)).clamped
            guard next != self.lockedGrid else { return }
            TmuxClient.resizeWindow(self.session.name, to: next)
            self.lockedGrid = next
            GhosttyLog.write("resize-window name=\(self.session.name) grid=\(next.cols)x\(next.rows)")
        }
    }

    private func observeWindow(_ window: NSWindow) {
        let names: [Notification.Name] = [
            NSWindow.didResizeNotification,
            NSWindow.didEnterFullScreenNotification,
            NSWindow.didExitFullScreenNotification,
            NSWindow.didChangeScreenNotification,
        ]
        for name in names {
            windowObservers.append(
                NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.syncSize()
                    }
                }
            )
        }
    }

    private func removeWindowObservers() {
        for observer in windowObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        windowObservers.removeAll()
    }

    /// Only forwarded when a real screen is known: a zero display ID stops the
    /// renderer's vsync source instead of falling back to the main display.
    private func syncDisplayID() {
        guard let surface, let screen = window?.screen else { return }
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let displayID = (screen.deviceDescription[key] as? NSNumber)?.uint32Value else { return }
        ghostty_surface_set_display_id(surface, displayID)
    }

    // MARK: Focus

    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        if result, let surface {
            ghostty_surface_set_focus(surface, true)
            syncDisplayID()
            ghostty_surface_refresh(surface)
        }
        return result
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result, let surface {
            ghostty_surface_set_focus(surface, false)
        }
        return result
    }

    // MARK: Mouse

    override func mouseDown(with event: NSEvent) {
        if window?.firstResponder !== self {
            window?.makeFirstResponder(self)
        }
        sendMouseButton(GHOSTTY_MOUSE_PRESS, event: event)
    }

    override func mouseUp(with event: NSEvent) {
        sendMouseButton(GHOSTTY_MOUSE_RELEASE, event: event)
    }

    override func rightMouseDown(with event: NSEvent) {
        sendMouseButton(GHOSTTY_MOUSE_PRESS, event: event)
    }

    override func rightMouseUp(with event: NSEvent) {
        sendMouseButton(GHOSTTY_MOUSE_RELEASE, event: event)
    }

    override func otherMouseDown(with event: NSEvent) {
        sendMouseButton(GHOSTTY_MOUSE_PRESS, event: event)
    }

    override func otherMouseUp(with event: NSEvent) {
        sendMouseButton(GHOSTTY_MOUSE_RELEASE, event: event)
    }

    override func mouseMoved(with event: NSEvent) {
        sendMousePosition(event)
    }

    override func mouseDragged(with event: NSEvent) {
        sendMousePosition(event)
    }

    override func rightMouseDragged(with event: NSEvent) {
        sendMousePosition(event)
    }

    override func otherMouseDragged(with event: NSEvent) {
        sendMousePosition(event)
    }

    override func mouseExited(with event: NSEvent) {
        guard let surface else { return }
        ghostty_surface_mouse_pos(surface, -1, -1, GhosttyInput.mods(event.modifierFlags))
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        bounds.contains(point) ? self : nil
    }

    override func scrollWheel(with event: NSEvent) {
        enqueueScroll(event)
    }

    /// Swallow the wheel so Ghostty never turns it into Up/Down (command history).
    fileprivate func consumeScroll(_ event: NSEvent) -> NSEvent? {
        guard window != nil else { return event }
        let point: NSPoint
        if event.window == nil || event.window === window {
            let windowPoint = event.window == nil
                ? (window?.convertPoint(fromScreen: NSEvent.mouseLocation) ?? .zero)
                : event.locationInWindow
            point = convert(windowPoint, from: nil)
        } else {
            return event
        }
        guard bounds.contains(point) else { return event }
        enqueueScroll(event)
        return nil
    }

    fileprivate func enqueueScroll(_ event: NSEvent) {
        let rowHeight = lockedGrid.map { bounds.height / CGFloat(max(1, $0.rows)) } ?? 16
        pendingScrollRemainder += TmuxClient.scrollDelta(from: event, rowHeight: rowHeight)
        let lines = Int(pendingScrollRemainder.rounded(.towardZero))
        guard lines != 0 else { return }
        pendingScrollRemainder -= Double(lines)
        pendingScrollLines += lines
        pendingScrollLines = max(-40, min(40, pendingScrollLines))
        guard scrollFlushTask == nil else { return }
        let name = session.name
        scrollFlushTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(16))
            let n = pendingScrollLines
            pendingScrollLines = 0
            scrollFlushTask = nil
            guard n != 0 else { return }
            Task.detached {
                TmuxClient.scroll(name, lines: n)
            }
        }
    }

    private func sendMouseButton(_ state: ghostty_input_mouse_state_e, event: NSEvent) {
        guard let surface else { return }
        _ = ghostty_surface_mouse_button(
            surface,
            state,
            GhosttyInput.mouseButton(event.buttonNumber),
            GhosttyInput.mods(event.modifierFlags)
        )
    }

    private func sendMousePosition(_ event: NSEvent) {
        guard let surface else { return }
        let point = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(
            surface,
            point.x,
            frame.height - point.y,
            GhosttyInput.mods(event.modifierFlags)
        )
    }

    // MARK: Keyboard

    override func keyDown(with event: NSEvent) {
        guard let surface else {
            interpretKeyEvents([event])
            return
        }

        // Ghostty may remap modifiers (option-as-alt, for example). Apply the exact
        // resulting states to the event we hand to AppKit for text translation.
        let ghosttyTranslationMods = GhosttyInput.modifierFlags(
            ghostty_surface_key_translation_mods(surface, GhosttyInput.mods(event.modifierFlags))
        )
        var translationMods = event.modifierFlags
        for flag in [NSEvent.ModifierFlags.shift, .control, .option, .command] {
            if ghosttyTranslationMods.contains(flag) {
                translationMods.insert(flag)
            } else {
                translationMods.remove(flag)
            }
        }

        // Reuse the original event when the mods are unchanged: AppKit relies on
        // event identity for multi-keystroke input methods.
        let translationEvent: NSEvent
        if translationMods == event.modifierFlags {
            translationEvent = event
        } else {
            translationEvent = NSEvent.keyEvent(
                with: event.type,
                location: event.locationInWindow,
                modifierFlags: translationMods,
                timestamp: event.timestamp,
                windowNumber: event.windowNumber,
                context: nil,
                characters: event.characters(byApplyingModifiers: translationMods) ?? "",
                charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "",
                isARepeat: event.isARepeat,
                keyCode: event.keyCode
            ) ?? event
        }

        let action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS

        keyTextAccumulator = []
        defer { keyTextAccumulator = nil }

        let hadMarkedText = markedText.length > 0
        interpretKeyEvents([translationEvent])
        syncPreedit(clearIfNeeded: hadMarkedText)

        let composing = markedText.length > 0 || hadMarkedText

        if let accumulated = keyTextAccumulator, !accumulated.isEmpty {
            for text in accumulated {
                _ = sendKey(action, event: event, translationEvent: translationEvent, text: text)
            }
            return
        }

        _ = sendKey(
            action,
            event: event,
            translationEvent: translationEvent,
            text: translationEvent.ghosttyCharacters,
            composing: composing
        )
    }

    override func keyUp(with event: NSEvent) {
        _ = sendKey(GHOSTTY_ACTION_RELEASE, event: event)
    }

    override func flagsChanged(with event: NSEvent) {
        let mod: UInt
        switch event.keyCode {
        case 0x39: mod = NSEvent.ModifierFlags.capsLock.rawValue
        case 0x38, 0x3C: mod = NSEvent.ModifierFlags.shift.rawValue
        case 0x3B, 0x3E: mod = NSEvent.ModifierFlags.control.rawValue
        case 0x3A, 0x3D: mod = NSEvent.ModifierFlags.option.rawValue
        case 0x37, 0x36: mod = NSEvent.ModifierFlags.command.rawValue
        default: return
        }

        let action = event.modifierFlags.rawValue & mod != 0
            ? GHOSTTY_ACTION_PRESS
            : GHOSTTY_ACTION_RELEASE
        _ = sendKey(action, event: event)
    }

    @discardableResult
    private func sendKey(
        _ action: ghostty_input_action_e,
        event: NSEvent,
        translationEvent: NSEvent? = nil,
        text: String? = nil,
        composing: Bool = false
    ) -> Bool {
        guard let surface else { return false }

        var keyEvent = event.ghosttyKeyEvent(action, translationMods: translationEvent?.modifierFlags)
        keyEvent.composing = composing

        // Ghostty encodes control characters itself, so only pass printable text.
        if let text, !text.isEmpty, let first = text.utf8.first, first >= 0x20 {
            return text.withCString { pointer in
                keyEvent.text = pointer
                return ghostty_surface_key(surface, keyEvent)
            }
        }

        return ghostty_surface_key(surface, keyEvent)
    }

    // MARK: Clipboard actions

    @IBAction func copy(_ sender: Any?) {
        performBindingAction("copy_to_clipboard")
    }

    @IBAction func paste(_ sender: Any?) {
        performBindingAction("paste_from_clipboard")
    }

    @IBAction func pasteAsPlainText(_ sender: Any?) {
        performBindingAction("paste_from_clipboard")
    }

    @IBAction override func selectAll(_ sender: Any?) {
        performBindingAction("select_all")
    }

    private func performBindingAction(_ action: String) {
        guard let surface else { return }
        _ = ghostty_surface_binding_action(surface, action, UInt(action.utf8.count))
    }

    // MARK: Preedit

    private func syncPreedit(clearIfNeeded: Bool) {
        guard let surface else { return }
        if markedText.length > 0 {
            let text = markedText.string
            text.withCString { pointer in
                ghostty_surface_preedit(surface, pointer, UInt(text.utf8.count))
            }
        } else if clearIfNeeded {
            ghostty_surface_preedit(surface, nil, 0)
        }
    }

    // MARK: NSTextInputClient

    override func doCommand(by selector: Selector) {
        // Swallow unhandled commands so AppKit does not beep at every control key.
    }

    func hasMarkedText() -> Bool {
        markedText.length > 0
    }

    func markedRange() -> NSRange {
        guard markedText.length > 0 else { return NSRange() }
        return NSRange(location: 0, length: markedText.length - 1)
    }

    func selectedRange() -> NSRange {
        NSRange()
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        switch string {
        case let value as NSAttributedString:
            markedText = NSMutableAttributedString(attributedString: value)
        case let value as String:
            markedText = NSMutableAttributedString(string: value)
        default:
            break
        }
    }

    func unmarkText() {
        markedText = NSMutableAttributedString()
    }

    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        nil
    }

    func validAttributesForMarkedText() -> [NSAttributedString.Key] {
        []
    }

    func characterIndex(for point: NSPoint) -> Int {
        0
    }

    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let surface else { return NSRect(x: frame.origin.x, y: frame.origin.y, width: 0, height: 0) }

        var x: Double = 0
        var y: Double = 0
        var width: Double = 0
        var height: Double = 0
        ghostty_surface_ime_point(surface, &x, &y, &width, &height)

        let viewRect = NSRect(x: x, y: frame.height - y, width: width, height: max(height, 1))
        let windowRect = convert(viewRect, to: nil)
        guard let window else { return windowRect }
        return window.convertToScreen(windowRect)
    }

    func insertText(_ string: Any, replacementRange: NSRange) {
        guard NSApp.currentEvent != nil else { return }

        let text: String
        switch string {
        case let value as NSAttributedString: text = value.string
        case let value as String: text = value
        default: return
        }

        unmarkText()

        // Inside a keyDown the text is replayed with the key event so Ghostty can
        // apply its own encoding; outside of one it is committed directly.
        if keyTextAccumulator != nil {
            keyTextAccumulator?.append(text)
            return
        }

        guard let surface else { return }
        text.withCString { pointer in
            ghostty_surface_text(surface, pointer, UInt(text.utf8.count))
        }
    }
}

@MainActor
enum SessionFileDrop {
    static let pasteboardTypes: [NSPasteboard.PasteboardType] = [
        .fileURL,
        NSPasteboard.PasteboardType("NSFilenamesPboardType"),
    ]

    static func urls(from info: NSDraggingInfo) -> [URL] {
        let board = info.draggingPasteboard
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
        ]) as? [URL] {
            return urls.filter(\.isFileURL)
        }
        if let paths = board.propertyList(forType: NSPasteboard.PasteboardType("NSFilenamesPboardType")) as? [String] {
            return paths.map { URL(fileURLWithPath: $0) }
        }
        return []
    }

    static func urls(from providers: [NSItemProvider]) async -> [URL] {
        var urls: [URL] = []
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            if let url = await loadFileURL(provider) {
                urls.append(url)
            }
        }
        return urls
    }

    static func entered(_ sender: NSDraggingInfo, host: TerminalHostView?) -> NSDragOperation {
        let urls = urls(from: sender)
        host?.setDropTargeted(!urls.isEmpty)
        return urls.isEmpty ? [] : .copy
    }

    static func input(from urls: [URL]) -> String {
        guard !urls.isEmpty else { return "" }
        return urls.map { quote($0.path) }.joined(separator: " ") + " "
    }

    private static func quote(_ path: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "/._-+@%=,~"))
        if path.unicodeScalars.allSatisfy({ allowed.contains($0) }) {
            return path
        }
        return "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func loadFileURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                let url: URL?
                if let value = item as? URL {
                    url = value
                } else if let value = item as? NSURL {
                    url = value as URL
                } else if let data = item as? Data {
                    url = URL(dataRepresentation: data, relativeTo: nil)
                } else {
                    url = nil
                }
                continuation.resume(returning: url?.isFileURL == true ? url : nil)
            }
        }
    }
}

/// Sits above the Metal surface so the wheel never reaches Ghostty.
@MainActor
private final class TerminalScrollCatcher: NSView {
    weak var surfaceView: GhosttySurfaceView?

    override var acceptsFirstResponder: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? {
        bounds.contains(point) ? self : nil
    }

    override func scrollWheel(with event: NSEvent) {
        surfaceView?.enqueueScroll(event)
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(surfaceView)
        surfaceView?.mouseDown(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        surfaceView?.mouseUp(with: event)
    }

    override func rightMouseDown(with event: NSEvent) {
        surfaceView?.rightMouseDown(with: event)
    }

    override func rightMouseUp(with event: NSEvent) {
        surfaceView?.rightMouseUp(with: event)
    }

    override func otherMouseDown(with event: NSEvent) {
        surfaceView?.otherMouseDown(with: event)
    }

    override func otherMouseUp(with event: NSEvent) {
        surfaceView?.otherMouseUp(with: event)
    }

    override func mouseMoved(with event: NSEvent) {
        surfaceView?.mouseMoved(with: event)
    }

    override func mouseDragged(with event: NSEvent) {
        surfaceView?.mouseDragged(with: event)
    }

    override func rightMouseDragged(with event: NSEvent) {
        surfaceView?.rightMouseDragged(with: event)
    }

    override func otherMouseDragged(with event: NSEvent) {
        surfaceView?.otherMouseDragged(with: event)
    }

    override func mouseExited(with event: NSEvent) {
        surfaceView?.mouseExited(with: event)
    }

    override func magnify(with event: NSEvent) {
        surfaceView?.magnify(with: event)
    }
}

private final class TerminalDropOverlay: NSView {
    private let label = NSTextField(labelWithString: "Drop files here")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.withAlphaComponent(0.45).cgColor
        label.font = .systemFont(ofSize: 22, weight: .semibold)
        label.textColor = .white
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }
}
