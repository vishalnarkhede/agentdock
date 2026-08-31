import AppKit
import Foundation

/// Talk to the local tmux server the same way the web PTY path does.
///
/// Agent sessions keep `window-size manual`. A new client — Ghostty, iTerm,
/// or a raw `tmux attach` — must not change that size: Cursor and Claude
/// answer SIGWINCH by rewriting the transcript, which is the jump to the
/// bottom on open. Only an explicit `resize-window` (user dragged the
/// AgentDock frame) is allowed to move it.
enum TmuxClient {
    struct Size: Equatable {
        var cols: Int
        var rows: Int

        var clamped: Size {
            Size(
                cols: min(500, max(20, cols)),
                rows: min(400, max(5, rows))
            )
        }
    }

    static func configure(_ session: String) {
        _ = run(["set-option", "-t", target(session), "status", "off"])
        _ = run(["set-option", "-t", target(session), "mouse", "off"])
        _ = run(["set-option", "-w", "-t", target(session), "window-size", "manual"])
        _ = run(["set-option", "-t", target(session), "fill-character", " "])
    }

    static func measureWindow(_ session: String) -> Size? {
        guard let stdout = output([
            "display-message", "-p", "-t", target(session),
            "#{window_width} #{window_height}",
        ]) else { return nil }
        let parts = stdout.split(whereSeparator: \.isWhitespace)
        guard parts.count >= 2,
              let cols = Int(parts[0]), cols > 0,
              let rows = Int(parts[1]), rows > 0
        else { return nil }
        return Size(cols: cols, rows: rows)
    }

    /// Move the view through the pane's history. Same convention as the web
    /// PTY: positive lines go back, negative return toward the prompt.
    ///
    /// The wheel must not go to Ghostty. With mouse mode off, that becomes
    /// Up/Down and the agent walks its command history.
    @discardableResult
    static func scroll(_ session: String, lines: Int) -> Bool {
        let count = min(40, abs(lines))
        guard count > 0 else { return false }
        // Same argv as scrollPtySession: one tmux process, session name as
        // -t (not =name). A session target cannot enter copy-mode.
        let send = ["send-keys", "-X", "-N", String(count), "-t", session]
        if lines > 0 {
            return run(["copy-mode", "-e", "-t", session, ";"] + send + ["scroll-up"])
        }
        return run(send + ["scroll-down"])
    }

    /// Fraction of a row from one Mac wheel/trackpad event. Callers accumulate
    /// so a trackpad's 2px ticks become one tmux call, not one per event.
    static func scrollDelta(from event: NSEvent, rowHeight: CGFloat = 16) -> Double {
        let y = event.scrollingDeltaY
        guard y != 0, y.isFinite else { return 0 }
        if event.hasPreciseScrollingDeltas {
            return Double(y / max(rowHeight, 8))
        }
        return Double(y)
    }

    @discardableResult
    static func resizeWindow(_ session: String, to size: Size) -> Bool {
        let next = size.clamped
        return run([
            "resize-window", "-t", target(session),
            "-x", String(next.cols), "-y", String(next.rows),
        ])
    }

    private static func target(_ session: String) -> String {
        "=\(session)"
    }

    private static func run(_ args: [String]) -> Bool {
        launch(args).exitCode == 0
    }

    private static func output(_ args: [String]) -> String? {
        let result = launch(args, capture: true)
        guard result.exitCode == 0 else { return nil }
        return result.stdout
    }

    private static func launch(_ args: [String], capture: Bool = false) -> (exitCode: Int32, stdout: String?) {
        guard let tmux else { return (1, nil) }
        let process = Process()
        process.executableURL = tmux
        process.arguments = args
        process.environment = environment
        let stdout = Pipe()
        process.standardOutput = capture ? stdout : FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return (1, nil)
        }
        guard capture else { return (process.terminationStatus, nil) }
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        return (process.terminationStatus, String(data: data, encoding: .utf8))
    }

    private static let tmux: URL? = {
        let candidates = [
            "/opt/homebrew/bin/tmux",
            "/usr/local/bin/tmux",
            "/usr/bin/tmux",
        ]
        guard let path = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            return nil
        }
        return URL(filePath: path)
    }()

    private static let environment: [String: String] = {
        var environment = ProcessInfo.processInfo.environment
        let homebrew = "/opt/homebrew/bin"
        let current = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        if !current.split(separator: ":").contains(Substring(homebrew)) {
            environment["PATH"] = "\(homebrew):\(current)"
        }
        return environment
    }()
}
