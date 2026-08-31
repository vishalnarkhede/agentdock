import AppKit
import CodeEditSourceEditor
import CodeEditTextView

/// Holds the live text controller so the app can move the cursor and scroll the
/// view without rebuilding the editor.
///
/// CodeEdit 0.15 cannot do this through `SourceEditorState`. Its diff compares
/// `state.cursorPositions` against itself, so every external cursor update is
/// dropped, and the one place that does apply them — the controller's
/// initializer — passes `scrollToVisible: false`. A jump set through the state
/// binding therefore selects the right line and leaves the reader looking at the
/// top of the file.
final class NativeEditorBridge: TextViewCoordinator {
    private weak var controller: TextViewController?
    private var pendingLine: Int?
    private var attempts = 0
    private static let maxAttempts = 20
    var onTextChange: (@MainActor (String) -> Void)?

    func prepareCoordinator(controller: TextViewController) {
        MainActor.assumeIsolated { self.controller = controller }
    }

    /// The text is set and the view is measured by the time this runs, which is
    /// the earliest a scroll offset means anything.
    func controllerDidAppear(controller: TextViewController) {
        MainActor.assumeIsolated {
            self.controller = controller
            self.flush()
        }
    }

    func textViewDidChangeText(controller: TextViewController) {
        MainActor.assumeIsolated {
            guard let text = controller.textView?.textStorage?.string else { return }
            onTextChange?(text)
        }
    }

    /// Puts the cursor on `line` and scrolls it into the upper third of the view.
    ///
    /// Safe to call before the editor exists: the request is held and applied
    /// when the view appears, which is what a jump into a not-yet-open file needs.
    @MainActor
    func reveal(line: Int) {
        pendingLine = max(line, 1)
        attempts = 0
        flush()
    }

    @MainActor
    func cancelPendingReveal() {
        pendingLine = nil
        attempts = 0
    }

    /// 1-based line for a character offset, straight from the line index rather
    /// than by counting newlines.
    @MainActor
    func line(forOffset offset: Int) -> Int? {
        guard let textView = controller?.textView,
              let position = textView.layoutManager.textLineForOffset(offset) else { return nil }
        return position.index + 1
    }

    /// The identifier under `range`, read from a window around it so a Cmd-click
    /// never copies the whole document.
    @MainActor
    func identifier(around range: NSRange) -> String? {
        guard let textView = controller?.textView, let storage = textView.textStorage else { return nil }
        let length = storage.length
        guard length > 0 else { return nil }
        let anchor = range.location == NSNotFound ? 0 : min(max(0, range.location), length)
        let start = max(0, anchor - 128)
        let end = min(length, anchor + max(range.length, 0) + 128)
        let window = NSRange(location: start, length: end - start)
        let text = storage.attributedSubstring(from: window).string as NSString
        let local = NSRange(location: anchor - start, length: min(max(range.length, 0), window.length - (anchor - start)))
        return Identifier.at(local, in: text)
    }

    @MainActor
    private func flush() {
        guard let line = pendingLine else { return }
        guard let controller,
              let textView = controller.textView,
              let position = textView.layoutManager.textLineForIndex(line - 1) else {
            retry()
            return
        }
        controller.setCursorPositions([
            CursorPosition(range: NSRange(location: position.range.location, length: 0))
        ])

        guard let scrollView = controller.scrollView else {
            retry()
            return
        }
        let height = scrollView.contentView.bounds.height
        guard height > 1 else {
            retry()
            return
        }
        pendingLine = nil
        attempts = 0
        let target = max(0, position.yPos - height / 3)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: target))
        scrollView.reflectScrolledClipView(scrollView.contentView)
        // The gutter draws from the clip view's bounds, so it needs the new offset.
        NotificationCenter.default.post(name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
    }

    /// The text and the frame arrive on different runloop turns while a file is
    /// opening, so a jump can be early rather than wrong.
    @MainActor
    private func retry() {
        guard attempts < Self.maxAttempts else {
            pendingLine = nil
            attempts = 0
            return
        }
        attempts += 1
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(16))
            self?.flush()
        }
    }
}
