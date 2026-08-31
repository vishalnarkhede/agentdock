import Foundation

enum SessionStatus: String, Codable {
    case waiting
    case working
    case background
    case shell
    case unknown
    case stopped
}

struct Worktree: Codable, Hashable {
    let repoPath: String
    let wtDir: String
}

struct StatusLine: Codable, Hashable {
    let type: String
    let message: String
}

struct AgentSession: Identifiable, Codable, Hashable {
    var id: String { name }

    let name: String
    let displayName: String
    let windows: Int
    let attached: Bool
    let created: Double
    let path: String
    let worktrees: [Worktree]
    let status: SessionStatus
    let statusLine: StatusLine?
    let agentType: String?
    let parentSession: String?
    let children: [String]?
    let sessionType: String?
    let meta: [String: String]?
}

enum WorkspaceTab: String, CaseIterable, Identifiable {
    case terminal
    case files
    case plan
    case changes

    var id: String { rawValue }
    var title: String { rawValue.capitalized }

    var systemImage: String {
        switch self {
        case .terminal: "terminal"
        case .files: "folder"
        case .plan: "list.bullet.clipboard"
        case .changes: "arrow.triangle.branch"
        }
    }
}
