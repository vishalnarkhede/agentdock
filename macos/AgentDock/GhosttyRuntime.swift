import AppKit
import GhosttyKit

@MainActor
final class GhosttyRuntime {
    static let shared = GhosttyRuntime()

    static let configDidChange = Notification.Name("AgentDockGhosttyConfigDidChange")

    private(set) var app: ghostty_app_t?
    private var config: ghostty_config_t?
    private var lastPreferences = NativePreferences()
    private(set) var initializationError: String?

    private init() {
        initialize()
        observeAppState()
    }

    func createSurface(in view: NSView, session: AgentSession) -> ghostty_surface_t? {
        guard let app else { return nil }

        var surfaceConfig = ghostty_surface_config_new()
        surfaceConfig.platform_tag = GHOSTTY_PLATFORM_MACOS
        surfaceConfig.platform = ghostty_platform_u(
            macos: ghostty_platform_macos_s(
                nsview: Unmanaged.passUnretained(view).toOpaque()
            )
        )
        surfaceConfig.userdata = Unmanaged.passUnretained(view).toOpaque()
        surfaceConfig.scale_factor = Double(
            view.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        )
        surfaceConfig.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
        surfaceConfig.wait_after_command = true
        surfaceConfig.font_size = Float(lastPreferences.terminalFontSize)
        if GhosttyLog.enabled {
            surfaceConfig.renderer_event_cb = { _, event in
                GhosttyLog.rendererEvent(event.rawValue)
            }
        }

        // ignore-size: attach must not change the window. After the first
        // paint, a real user resize (including maximize) calls resize-window
        // itself. Without this flag, attach at the dummy PTY size SIGWINCHes
        // the agent and it replays its transcript.
        let attach = "exec tmux attach-session -f ignore-size -t \(shellQuote("=\(session.name)"))"
        let command = "/bin/zsh -l -c \(shellQuote(attach))"
        let workingDirectory = session.worktrees.first?.wtDir ?? session.path

        return command.withCString { commandPointer in
            surfaceConfig.command = commandPointer
            return workingDirectory.withCString { directoryPointer in
                surfaceConfig.working_directory = directoryPointer
                return ghostty_surface_new(app, &surfaceConfig)
            }
        }
    }

    func tick() {
        guard let app else { return }
        ghostty_app_tick(app)
    }

    var activeConfig: ghostty_config_t? { config }

    func applyPreferences(_ preferences: NativePreferences) {
        lastPreferences = preferences
        guard app != nil else { return }
        rebuildConfig()
        NotificationCenter.default.post(name: Self.configDidChange, object: nil)
    }

    func applyConfig(to surface: ghostty_surface_t) {
        guard let config else { return }
        ghostty_surface_update_config(surface, config)
    }

    private func rebuildConfig() {
        guard let next = ghostty_config_new() else { return }
        ghostty_config_load_default_files(next)
        ghostty_config_load_recursive_files(next)
        applyPreferenceOverlay(next, lastPreferences)
        ghostty_config_finalize(next)
        if let app {
            ghostty_app_update_config(app, next)
        }
        if let previous = config {
            ghostty_config_free(previous)
        }
        config = next
    }

    private func applyPreferenceOverlay(_ config: ghostty_config_t, _ preferences: NativePreferences) {
        let scrollbackBytes = max(preferences.scrollback * 256, 256_000)
        let overlay = """
        font-size = \(preferences.terminalFontSize)
        cursor-style-blink = \(preferences.cursorBlink)
        scrollback-limit = \(scrollbackBytes)
        """
        overlay.withCString { pointer in
            "agentdock".withCString { origin in
                ghostty_config_load_string(config, pointer, UInt(overlay.utf8.count), origin)
            }
        }
    }

    private func initialize() {
        let result = ghostty_init(UInt(CommandLine.argc), CommandLine.unsafeArgv)
        guard result == GHOSTTY_SUCCESS else {
            initializationError = "Ghostty initialization failed with code \(result)."
            return
        }

        guard let config = ghostty_config_new() else {
            initializationError = "Ghostty could not create its configuration."
            return
        }

        ghostty_config_load_default_files(config)
        ghostty_config_load_recursive_files(config)
        applyPreferenceOverlay(config, lastPreferences)
        ghostty_config_finalize(config)

        var runtimeConfig = ghostty_runtime_config_s()
        runtimeConfig.userdata = Unmanaged.passUnretained(self).toOpaque()
        runtimeConfig.supports_selection_clipboard = false
        runtimeConfig.wakeup_cb = { userdata in
            guard let userdata else { return }
            let runtime = Unmanaged<GhosttyRuntime>.fromOpaque(userdata).takeUnretainedValue()
            DispatchQueue.main.async {
                runtime.tick()
            }
        }
        runtimeConfig.action_cb = { _, _, _ in false }
        runtimeConfig.read_clipboard_cb = { userdata, location, state in
            GhosttyRuntime.readClipboard(userdata, location: location, state: state)
        }
        runtimeConfig.confirm_read_clipboard_cb = { userdata, string, state, _ in
            GhosttyRuntime.completeClipboardRequest(userdata, string: string, state: state)
        }
        runtimeConfig.write_clipboard_cb = { userdata, location, content, length, _ in
            GhosttyRuntime.writeClipboard(userdata, location: location, content: content, length: length)
        }
        runtimeConfig.close_surface_cb = { _, _ in }

        guard let app = ghostty_app_new(&runtimeConfig, config) else {
            ghostty_config_free(config)
            initializationError = "Ghostty could not create its application runtime."
            return
        }

        self.config = config
        self.app = app
        ghostty_app_set_focus(app, NSApp.isActive)
    }

    private func observeAppState() {
        let center = NotificationCenter.default
        center.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let app = self?.app else { return }
                ghostty_app_set_focus(app, true)
            }
        }
        center.addObserver(
            forName: NSApplication.didResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let app = self?.app else { return }
                ghostty_app_set_focus(app, false)
            }
        }
        center.addObserver(
            forName: NSTextInputContext.keyboardSelectionDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let app = self?.app else { return }
                ghostty_app_keyboard_changed(app)
            }
        }
    }

    // MARK: Clipboard

    private static func surfaceView(from userdata: UnsafeMutableRawPointer?) -> GhosttySurfaceView? {
        guard let userdata else { return nil }
        return Unmanaged<GhosttySurfaceView>.fromOpaque(userdata).takeUnretainedValue()
    }

    private static func pasteboard(for location: ghostty_clipboard_e) -> NSPasteboard? {
        switch location {
        case GHOSTTY_CLIPBOARD_STANDARD: NSPasteboard.general
        default: nil
        }
    }

    private static func readClipboard(
        _ userdata: UnsafeMutableRawPointer?,
        location: ghostty_clipboard_e,
        state: UnsafeMutableRawPointer?
    ) -> Bool {
        MainActor.assumeIsolated {
            guard let view = surfaceView(from: userdata), let surface = view.surface else { return false }
            guard let pasteboard = pasteboard(for: location) else { return false }
            guard let text = pasteboard.string(forType: .string) else { return false }
            text.withCString { pointer in
                ghostty_surface_complete_clipboard_request(surface, pointer, state, true)
            }
            return true
        }
    }

    private static func completeClipboardRequest(
        _ userdata: UnsafeMutableRawPointer?,
        string: UnsafePointer<CChar>?,
        state: UnsafeMutableRawPointer?
    ) {
        MainActor.assumeIsolated {
            guard let view = surfaceView(from: userdata), let surface = view.surface else { return }
            guard let string else { return }
            ghostty_surface_complete_clipboard_request(surface, string, state, true)
        }
    }

    private static func writeClipboard(
        _ userdata: UnsafeMutableRawPointer?,
        location: ghostty_clipboard_e,
        content: UnsafePointer<ghostty_clipboard_content_s>?,
        length: Int
    ) {
        MainActor.assumeIsolated {
            guard let pasteboard = pasteboard(for: location) else { return }
            guard let content, length > 0 else { return }

            var text: String?
            for index in 0..<length {
                let item = content[index]
                guard let mimePointer = item.mime, let dataPointer = item.data else { continue }
                guard String(cString: mimePointer) == "text/plain" else { continue }
                text = String(cString: dataPointer)
                break
            }

            guard let text else { return }
            pasteboard.declareTypes([.string], owner: nil)
            pasteboard.setString(text, forType: .string)
        }
    }

    private func shellQuote(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}
