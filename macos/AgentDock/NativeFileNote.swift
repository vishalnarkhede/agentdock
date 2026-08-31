import Foundation

struct FileCodeSelection: Equatable {
    let range: NSRange
    let text: String
    let startLine: Int
    let endLine: Int

    var lineLabel: String {
        startLine == endLine ? "line \(startLine)" : "lines \(startLine)–\(endLine)"
    }
}

enum FileNoteMessage {
    static let maxLines = 120
    static let maxCharacters = 6_000

    static func selection(in source: String, range: NSRange) -> FileCodeSelection? {
        let text = source as NSString
        guard range.location != NSNotFound,
              range.location >= 0,
              range.length > 0,
              NSMaxRange(range) <= text.length
        else { return nil }

        let lastSelectedOffset = max(range.location, NSMaxRange(range) - 1)
        return FileCodeSelection(
            range: range,
            text: text.substring(with: range),
            startLine: lineNumber(at: range.location, in: text),
            endLine: lineNumber(at: lastSelectedOffset, in: text)
        )
    }

    static func relativePath(_ path: String, roots: [String]) -> String {
        for root in roots.sorted(by: { $0.count > $1.count }) {
            let prefix = root.hasSuffix("/") ? root : root + "/"
            if path.hasPrefix(prefix) {
                return String(path.dropFirst(prefix.count))
            }
        }
        return URL(fileURLWithPath: path).lastPathComponent
    }

    static func build(
        path: String,
        selection: FileCodeSelection,
        note: String,
        language: String?
    ) -> String {
        var body = selection.text
        var trimmed = false
        let lines = body.components(separatedBy: "\n")
        if lines.count > maxLines {
            body = lines.prefix(maxLines).joined(separator: "\n")
            trimmed = true
        }
        if body.count > maxCharacters {
            body = String(body.prefix(maxCharacters))
            trimmed = true
        }

        let location = selection.startLine == selection.endLine
            ? "\(path):\(selection.startLine)"
            : "\(path):\(selection.startLine)-\(selection.endLine)"
        return "In \(location)\n"
            + "```\(language ?? "")\n"
            + body
            + (trimmed ? "\n… (selection trimmed)" : "")
            + "\n```\n"
            + note.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func lineNumber(at offset: Int, in text: NSString) -> Int {
        guard offset > 0 else { return 1 }
        var line = 1
        for index in 0..<min(offset, text.length) where text.character(at: index) == 10 {
            line += 1
        }
        return line
    }
}
