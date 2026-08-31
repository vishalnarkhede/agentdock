import Foundation

enum NativeQueueBucket: String, CaseIterable {
    case blocked
    case review
    case working
    case idle
    case stale

    var label: String {
        switch self {
        case .blocked: "Waiting on you"
        case .review: "Ready to review"
        case .working: "Working"
        case .idle: "Idle"
        case .stale: "Stale"
        }
    }

    var needsAttention: Bool {
        self == .blocked || self == .review || self == .working
    }
}

struct NativeQueueCounts: Equatable {
    var blocked = 0
    var review = 0
    var working = 0

    var summary: String {
        var parts: [String] = []
        if blocked > 0 { parts.append("\(blocked) waiting on you") }
        if review > 0 { parts.append("\(review) to review") }
        if working > 0 { parts.append("\(working) working") }
        return parts.isEmpty ? "Nothing waiting on you" : parts.joined(separator: " · ")
    }
}

/// What the sidebar shows — hook `statusLine` wins, same as the web row.
enum SessionDisplayKind: String {
    case working
    case review
    case done
    case blocked
    case error
    case idle
    case stale
    case unknown

    static func of(_ session: AgentSession) -> SessionDisplayKind {
        if session.status == .stopped { return .stale }
        switch session.statusLine?.type {
        case "error": return .error
        case "input": return .blocked
        case "done": return .done
        default: break
        }
        switch session.status {
        case .working, .background: return .working
        case .waiting: return .review
        case .shell: return .done
        case .stopped: return .stale
        case .unknown: return .unknown
        }
    }

    var badge: String {
        switch self {
        case .working: "Working"
        case .review: "Review"
        case .done: "Done"
        case .blocked: "Input"
        case .error: "Error"
        case .idle: "Idle"
        case .stale: "Stopped"
        case .unknown: "Unknown"
        }
    }

    var isAttention: Bool {
        self == .working || self == .review || self == .done || self == .blocked || self == .error
    }
}

enum NativeQueue {
    static func bucket(_ session: AgentSession) -> NativeQueueBucket {
        if session.status == .stopped { return .stale }
        if session.statusLine?.type == "input" || session.statusLine?.type == "error" {
            return .blocked
        }
        if session.status == .working || session.status == .background { return .working }
        if session.statusLine?.type == "done" || session.status == .waiting { return .review }
        return .idle
    }

    static func topLevel(_ sessions: [AgentSession]) -> [AgentSession] {
        sessions.filter { $0.parentSession == nil }
    }

    static func counts(_ sessions: [AgentSession]) -> NativeQueueCounts {
        topLevel(sessions).reduce(into: NativeQueueCounts()) { result, session in
            switch bucket(session) {
            case .blocked: result.blocked += 1
            case .review: result.review += 1
            case .working: result.working += 1
            case .idle, .stale: break
            }
        }
    }

    static func firstAttention(in sessions: [AgentSession]) -> AgentSession? {
        let top = topLevel(sessions)
        for kind in [NativeQueueBucket.blocked, .review, .working] {
            if let session = top.first(where: { bucket($0) == kind }) { return session }
        }
        return nil
    }

    static func next(in sessions: [AgentSession], after selected: String?) -> AgentSession? {
        let top = topLevel(sessions)
        for kind in NativeQueueBucket.allCases {
            let candidates = top.filter { bucket($0) == kind }
            guard !candidates.isEmpty else { continue }
            let current = candidates.firstIndex { $0.name == selected } ?? -1
            return candidates[(current + 1) % candidates.count]
        }
        return nil
    }
}
