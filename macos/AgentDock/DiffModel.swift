import Foundation

/// A unified diff, split into files, hunks and numbered lines.
///
/// The server hands us `git diff HEAD` plus a `--no-index` diff per untracked
/// file, so the parser has to tolerate `/dev/null` sides and missing indexes.
enum DiffParser {
    static func files(from raw: String) -> [DiffFileChange] {
        guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var files: [DiffFileChange] = []
        var current: [String] = []

        for line in raw.components(separatedBy: "\n") {
            if line.hasPrefix("diff --git ") {
                if let file = file(from: current) { files.append(file) }
                current = [line]
            } else if !current.isEmpty {
                current.append(line)
            }
        }
        if let file = file(from: current) { files.append(file) }
        return files
    }

    private static func file(from lines: [String]) -> DiffFileChange? {
        guard let header = lines.first, header.hasPrefix("diff --git ") else { return nil }

        var oldPath: String?
        var newPath: String?
        var isNew = false
        var isDeleted = false
        var isBinary = false
        var hunks: [DiffHunk] = []
        var lineID = 0

        var oldNumber = 0
        var newNumber = 0

        for line in lines.dropFirst() {
            if line.hasPrefix("--- ") {
                oldPath = strippedPath(String(line.dropFirst(4)))
                continue
            }
            if line.hasPrefix("+++ ") {
                newPath = strippedPath(String(line.dropFirst(4)))
                continue
            }
            if line.hasPrefix("new file mode") { isNew = true; continue }
            if line.hasPrefix("deleted file mode") { isDeleted = true; continue }
            if line.hasPrefix("Binary files ") || line.hasPrefix("GIT binary patch") {
                isBinary = true
                continue
            }
            if line.hasPrefix("@@") {
                let starts = hunkStarts(line)
                oldNumber = starts.old
                newNumber = starts.new
                lineID += 1
                hunks.append(DiffHunk(id: lineID, header: line, lines: []))
                continue
            }
            guard !hunks.isEmpty else { continue }

            let kind: DiffLine.Kind
            if line.hasPrefix("+") {
                kind = .addition
            } else if line.hasPrefix("-") {
                kind = .deletion
            } else if line.hasPrefix("\\") {
                kind = .meta
            } else {
                kind = .context
            }

            lineID += 1
            var old: Int?
            var new: Int?
            switch kind {
            case .addition:
                new = newNumber
                newNumber += 1
            case .deletion:
                old = oldNumber
                oldNumber += 1
            case .context:
                old = oldNumber
                new = newNumber
                oldNumber += 1
                newNumber += 1
            case .meta:
                break
            }

            hunks[hunks.count - 1].lines.append(
                DiffLine(
                    id: lineID,
                    kind: kind,
                    oldNumber: old,
                    newNumber: new,
                    text: kind == .context ? String(line.dropFirst(min(1, line.count))) : String(line.dropFirst())
                )
            )
        }

        let path = pathFromHeader(header) ?? newPath ?? oldPath ?? "unknown"
        let additions = hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .addition }.count }
        let deletions = hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .deletion }.count }

        return DiffFileChange(
            path: path,
            previousPath: oldPath == newPath ? nil : oldPath,
            additions: additions,
            deletions: deletions,
            isNew: isNew || oldPath == nil,
            isDeleted: isDeleted || newPath == nil,
            isBinary: isBinary,
            hunks: hunks
        )
    }

    /// `diff --git a/dir/file.ts b/dir/file.ts` — the b-side is the current name.
    private static func pathFromHeader(_ header: String) -> String? {
        let body = String(header.dropFirst("diff --git ".count))
        guard let range = body.range(of: " b/") else { return nil }
        return String(body[range.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    }

    private static func strippedPath(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        if trimmed == "/dev/null" { return nil }
        if trimmed.hasPrefix("a/") || trimmed.hasPrefix("b/") { return String(trimmed.dropFirst(2)) }
        return trimmed
    }

    /// `@@ -12,7 +12,9 @@ func thing()` → (12, 12).
    private static func hunkStarts(_ header: String) -> (old: Int, new: Int) {
        let numbers = header
            .split(separator: "@")
            .first
            .map(String.init) ?? header
        var old = 1
        var new = 1
        for token in numbers.split(separator: " ") {
            let value = token.split(separator: ",").first.map(String.init) ?? ""
            if token.hasPrefix("-"), let parsed = Int(value.dropFirst()) { old = parsed }
            if token.hasPrefix("+"), let parsed = Int(value.dropFirst()) { new = parsed }
        }
        return (old, new)
    }
}

struct DiffFileChange: Identifiable, Hashable {
    var id: String { path }
    let path: String
    let previousPath: String?
    let additions: Int
    let deletions: Int
    let isNew: Bool
    let isDeleted: Bool
    let isBinary: Bool
    let hunks: [DiffHunk]

    var lineCount: Int { hunks.reduce(0) { $0 + $1.lines.count } }
    var fileName: String { path.components(separatedBy: "/").last ?? path }
    var directory: String {
        let parts = path.components(separatedBy: "/").dropLast()
        return parts.joined(separator: "/")
    }
    var changeLabel: String {
        if isBinary { return "binary" }
        if isNew { return "new" }
        if isDeleted { return "deleted" }
        if previousPath != nil { return "renamed" }
        return "modified"
    }
}

struct DiffHunk: Identifiable, Hashable {
    let id: Int
    let header: String
    var lines: [DiffLine]

    /// `@@ -12,7 +12,9 @@ func thing()` → `func thing()`.
    var context: String {
        guard let range = header.range(of: "@@", options: .backwards) else { return "" }
        return String(header[range.upperBound...]).trimmingCharacters(in: .whitespaces)
    }

    var range: String {
        guard let start = header.range(of: "@@"),
              let end = header.range(of: "@@", options: .backwards),
              start.upperBound <= end.lowerBound
        else { return header }
        return String(header[start.upperBound..<end.lowerBound]).trimmingCharacters(in: .whitespaces)
    }
}

struct DiffLine: Identifiable, Hashable {
    enum Kind {
        case context
        case addition
        case deletion
        case meta
    }

    let id: Int
    let kind: Kind
    let oldNumber: Int?
    let newNumber: Int?
    let text: String
}

struct GitStatusEntry: Identifiable, Hashable {
    var id: String { path }
    let code: String
    let path: String

    var label: String {
        let index = code.first ?? " "
        let worktree = code.dropFirst().first ?? " "
        if index == "?" { return "new" }
        if index == "A" { return "added" }
        if index == "D" || worktree == "D" { return "deleted" }
        if index == "R" { return "renamed" }
        if index == "M" || worktree == "M" { return "modified" }
        return code.trimmingCharacters(in: .whitespaces)
    }

    var isStaged: Bool {
        guard let index = code.first else { return false }
        return index != " " && index != "?"
    }

    static func parse(_ raw: String) -> [GitStatusEntry] {
        raw
            .components(separatedBy: "\n")
            .compactMap { line in
                guard line.count > 3 else { return nil }
                let code = String(line.prefix(2))
                var path = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                // Renames arrive as "old -> new"; the new name is what exists now.
                if let arrow = path.range(of: " -> ") {
                    path = String(path[arrow.upperBound...])
                }
                path = path.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                return path.isEmpty ? nil : GitStatusEntry(code: code, path: path)
            }
    }
}
