import CryptoKit
import SwiftUI

/// Split a plan into addressable blocks.
///
/// Ids are content hashes of one line, because that is what the server derives
/// comment anchors from (`planBlocks()` in `plan-comments.ts`). Presentation
/// grouping happens later, in `PlanGroup`, and must not change these ids.
enum PlanParser {
    static func blocks(from plan: String) -> [PlanBlock] {
        var output: [PlanBlock] = []
        var seen: [String: Int] = [:]
        var inFence = false

        for (index, raw) in plan.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let text = raw.trimmingCharacters(in: .whitespaces)
            if text.hasPrefix("```") || text.hasPrefix("~~~") {
                inFence.toggle()
                continue
            }
            guard !text.isEmpty else { continue }

            let baseID = sha1(normalize(text))
            let occurrence = seen[baseID, default: 0]
            seen[baseID] = occurrence + 1
            let id = occurrence == 0 ? baseID : "\(baseID):\(occurrence)"

            var kind: PlanBlock.Kind = .paragraph
            var level = 0
            var checked: Bool?

            if inFence {
                kind = .code
            } else if let hashes = text.prefix(while: { $0 == "#" }).count.nonzero,
                      text.dropFirst(hashes).first == " " {
                kind = .heading
                level = hashes
            } else if text == "---" || text == "***" || text == "___" {
                kind = .rule
            } else if text.hasPrefix(">") {
                kind = .quote
            } else if text.hasPrefix("|") {
                kind = .table
            } else if isList(raw: String(raw)) {
                kind = .list
                level = raw.prefix(while: { $0 == " " }).count / 2
                if text.range(of: #"^\s*(?:[-*+]|\d+[.)])\s+\[[ xX~/-]\]"#, options: .regularExpression) != nil {
                    checked = text.range(of: #"\[[xX]\]"#, options: .regularExpression) != nil
                }
            }

            output.append(
                PlanBlock(id: id, text: text, kind: kind, level: level, checked: checked, line: index)
            )
        }
        return output
    }

    /// Matches `normalize()` on the server: a step keeps its identity when the
    /// agent ticks its checkbox.
    static func normalize(_ value: String) -> String {
        normalizedListText(value)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    static func normalizedListText(_ value: String) -> String {
        value
            .replacingOccurrences(
                of: #"^\s*(?:[-*+]|\d+[.)])\s+"#,
                with: "",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: #"^\[[ xX~/-]\]\s*"#,
                with: "",
                options: .regularExpression
            )
    }

    private static func isList(raw: String) -> Bool {
        raw.range(of: #"^\s*(?:[-*+]|\d+[.)])\s+"#, options: .regularExpression) != nil
    }

    private static func sha1(_ value: String) -> String {
        Insecure.SHA1.hash(data: Data(value.utf8))
            .prefix(8)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}

private extension Int {
    var nonzero: Int? { self == 0 ? nil : self }
}

/// Consecutive blocks that read as one thing.
///
/// Comment anchors stay per line — the ids must keep matching what the server
/// derives from the plan file — but a fenced block or a markdown table is one
/// visual unit, and rendering each of its lines as a separate card is what made
/// the plan look like a dump of strings.
struct PlanGroup: Identifiable {
    let id: String
    let kind: PlanBlock.Kind
    let blocks: [PlanBlock]

    /// The block a comment on this group is attached to.
    var anchor: PlanBlock { blocks[0] }
    var level: Int { anchor.level }
    var text: String { blocks.map(\.text).joined(separator: "\n") }
    var ids: Set<String> { Set(blocks.map(\.id)) }

    static func group(_ blocks: [PlanBlock]) -> [PlanGroup] {
        var groups: [PlanGroup] = []
        var run: [PlanBlock] = []

        func flush() {
            guard let first = run.first else { return }
            groups.append(PlanGroup(id: first.id, kind: first.kind, blocks: run))
            run = []
        }

        for block in blocks {
            let mergeable = block.kind == .code || block.kind == .table || block.kind == .quote
            if mergeable, run.first?.kind == block.kind {
                run.append(block)
                continue
            }
            flush()
            run = [block]
            if !mergeable { flush() }
        }
        flush()
        return groups
    }
}

struct PlanOutlineItem: Identifiable, Hashable {
    let id: String
    let title: String
    let level: Int
    let done: Int
    let total: Int

    var progressLabel: String? { total == 0 ? nil : "\(done)/\(total)" }
}

extension PlanOutlineItem {
    /// Headings down to level 3, each carrying the checklist progress of the
    /// section it opens.
    static func outline(of blocks: [PlanBlock]) -> [PlanOutlineItem] {
        var items: [PlanOutlineItem] = []
        for (index, block) in blocks.enumerated() where block.kind == .heading && block.level <= 3 {
            var done = 0
            var total = 0
            for next in blocks[(index + 1)...] {
                if next.kind == .heading, next.level <= block.level { break }
                guard let checked = next.checked else { continue }
                total += 1
                if checked { done += 1 }
            }
            items.append(
                PlanOutlineItem(
                    id: block.id,
                    title: PlanText.headingTitle(block.text),
                    level: block.level,
                    done: done,
                    total: total
                )
            )
        }
        return items
    }
}

/// Markdown table rows, once the pipes and the `|---|` separator are gone.
struct PlanTable {
    let header: [String]
    let rows: [[String]]

    init(lines: [String]) {
        let parsed = lines.compactMap(PlanTable.cells)
        let body = parsed.filter { !PlanTable.isSeparator($0) }
        header = body.first ?? []
        rows = Array(body.dropFirst())
    }

    var columnCount: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    private static func cells(_ line: String) -> [String]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("|") else { return nil }
        var parts = trimmed.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        if parts.first?.isEmpty == true { parts.removeFirst() }
        if parts.last?.isEmpty == true { parts.removeLast() }
        return parts
    }

    private static func isSeparator(_ cells: [String]) -> Bool {
        !cells.isEmpty && cells.allSatisfy {
            $0.range(of: #"^:?-{2,}:?$"#, options: .regularExpression) != nil
        }
    }
}

enum PlanText {
    static func headingTitle(_ text: String) -> String {
        text
            .drop(while: { $0 == "#" })
            .trimmingCharacters(in: .whitespaces)
    }

    /// Inline markdown — bold, italic, links, code spans — as an AttributedString.
    ///
    /// Code spans come back only as a presentation intent, so the monospaced
    /// font has to be applied afterwards or `` `--flag` `` reads as prose.
    static func inline(_ source: String, size: CGFloat? = nil) -> AttributedString {
        var attributed: AttributedString
        do {
            attributed = try AttributedString(
                markdown: source,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
            )
        } catch {
            attributed = AttributedString(source)
        }

        let codeRanges = attributed.runs.compactMap { run -> Range<AttributedString.Index>? in
            guard run.inlinePresentationIntent?.contains(.code) == true else { return nil }
            return run.range
        }
        for range in codeRanges {
            attributed[range].font = .system(size: size ?? 12.5, design: .monospaced)
            attributed[range].foregroundColor = .accentColor
        }
        return attributed
    }
}
