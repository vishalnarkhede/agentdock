import Foundation

enum NativeTicket {
    static func parseID(_ input: String) -> String? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }

        if let match = firstMatch(#"/issue/([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})"#, in: value, group: 1) {
            return match.uppercased()
        }
        guard let match = firstMatch(#"\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b"#, in: value, group: 0)
        else { return nil }
        return match.uppercased()
    }

    static func promptLine(for id: String) -> String {
        "Linear ticket \(id) — read it with your Linear MCP tools before changing anything."
    }

    private static func firstMatch(
        _ pattern: String,
        in value: String,
        group: Int
    ) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
              let match = regex.firstMatch(
                in: value,
                range: NSRange(value.startIndex..., in: value)
              ),
              let range = Range(match.range(at: group), in: value)
        else { return nil }
        return String(value[range])
    }
}
