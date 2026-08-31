import Foundation

struct NativePreferences: Codable {
    var pinnedSessions: [String] = []
    var groupBy: String?
    var sortBy: String?
    var collapsedGroups: [String] = []
    var mruSessions: [String] = []
    var sessionStats: [String: SessionUsage] = [:]

    // Settings shared with the web dashboard.
    var theme = "cockpit"
    var fontSize = "medium"
    var cursorBlink = true
    var scrollback = 10_000
    var terminalFontSize = 14
    var customKeyboard = false
    var notificationsEnabled = true
    var notifyBlocked = true
    var notifyReview = true
    var notifyQuietEnabled = false
    var notifyQuietStart = 21
    var notifyQuietEnd = 8
    var notifyBatchEnabled = true
    var notifyRemindEnabled = false
    var defaultAgent = "claude"
    var defaultSkipPermissions = false
    var worktreePostCreate = ""
    var worktreeBranchPrefix = "wt-"
    var worktreeAutoRemove = false

    struct SessionUsage: Codable {
        var count: Int
        var last: Double
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pinnedSessions = try container.decodeIfPresent([String].self, forKey: .pinnedSessions) ?? []
        groupBy = try container.decodeIfPresent(String.self, forKey: .groupBy)
        sortBy = try container.decodeIfPresent(String.self, forKey: .sortBy)
        collapsedGroups = try container.decodeIfPresent([String].self, forKey: .collapsedGroups) ?? []
        mruSessions = try container.decodeIfPresent([String].self, forKey: .mruSessions) ?? []
        sessionStats = try container.decodeIfPresent(
            [String: SessionUsage].self,
            forKey: .sessionStats
        ) ?? [:]
        theme = try container.decodeIfPresent(String.self, forKey: .theme) ?? "cockpit"
        fontSize = try container.decodeIfPresent(String.self, forKey: .fontSize) ?? "medium"
        cursorBlink = try container.decodeIfPresent(Bool.self, forKey: .cursorBlink) ?? true
        scrollback = try container.decodeIfPresent(Int.self, forKey: .scrollback) ?? 10_000
        terminalFontSize = try container.decodeIfPresent(Int.self, forKey: .terminalFontSize) ?? 14
        customKeyboard = try container.decodeIfPresent(Bool.self, forKey: .customKeyboard) ?? false
        notificationsEnabled = try container.decodeIfPresent(Bool.self, forKey: .notificationsEnabled) ?? true
        notifyBlocked = try container.decodeIfPresent(Bool.self, forKey: .notifyBlocked) ?? true
        notifyReview = try container.decodeIfPresent(Bool.self, forKey: .notifyReview) ?? true
        notifyQuietEnabled = try container.decodeIfPresent(Bool.self, forKey: .notifyQuietEnabled) ?? false
        notifyQuietStart = try container.decodeIfPresent(Int.self, forKey: .notifyQuietStart) ?? 21
        notifyQuietEnd = try container.decodeIfPresent(Int.self, forKey: .notifyQuietEnd) ?? 8
        notifyBatchEnabled = try container.decodeIfPresent(Bool.self, forKey: .notifyBatchEnabled) ?? true
        notifyRemindEnabled = try container.decodeIfPresent(Bool.self, forKey: .notifyRemindEnabled) ?? false
        defaultAgent = try container.decodeIfPresent(String.self, forKey: .defaultAgent) ?? "claude"
        defaultSkipPermissions = try container.decodeIfPresent(Bool.self, forKey: .defaultSkipPermissions) ?? false
        worktreePostCreate = try container.decodeIfPresent(String.self, forKey: .worktreePostCreate) ?? ""
        worktreeBranchPrefix = try container.decodeIfPresent(String.self, forKey: .worktreeBranchPrefix) ?? "wt-"
        worktreeAutoRemove = try container.decodeIfPresent(Bool.self, forKey: .worktreeAutoRemove) ?? false
    }
}

struct RepositoryConfig: Codable, Identifiable, Hashable {
    var id: String { alias }
    let alias: String
    let path: String
    let remote: String?
}

struct CreateSessionPayload: Codable {
    let targets: [String]
    let name: String?
    let prompt: String?
    let grouped: Bool
    let isolated: Bool
    let dangerouslySkipPermissions: Bool
    let agentType: String
    let meta: [String: String]?
}

struct SessionTemplate: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let targets: [String]
    let prompt: String?
    let isolated: Bool?
    let grouped: Bool?
    let meta: [String: String]?
}

struct NewSessionTemplate: Codable {
    let name: String
    let targets: [String]
    let prompt: String?
    let isolated: Bool
    let grouped: Bool
    let meta: [String: String]?
}

struct CreatedSessions: Codable {
    let sessions: [String]
}

struct FileEntry: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let type: EntryType
    let ext: String?

    enum EntryType: String, Codable {
        case file
        case dir
    }
}

struct OpenFileDocument: Codable, Hashable {
    let path: String
    var content: String
    let language: String
    var size: Int
    var version: String
    var readOnly: Bool
}

struct FileSearchPayload: Codable {
    let files: [FileSearchHit]
    let content: [ContentSearchHit]
    let truncated: SearchTruncation
    let tookMs: Int
    let indexed: Int
    let tool: String
}

struct FileSearchHit: Codable, Identifiable, Hashable {
    var id: String { path }
    let path: String
    let rel: String
    let root: String
    let name: String
    let score: Double
    let positions: [Int]
}

struct ContentSearchHit: Codable, Identifiable, Hashable {
    var id: String { "\(path):\(line)" }
    let path: String
    let line: Int
    let text: String
}

struct SearchTruncation: Codable {
    let files: Bool
    let content: Bool
}

struct WriteFileResult: Codable {
    let ok: Bool?
    let version: String?
    let size: Int?
    let conflict: Bool?
    let error: String?
    let currentVersion: String?
    let currentContent: String?
}

struct PlanPayload: Codable {
    let plan: String?
    let hash: String
    let unchanged: Bool
}

struct PlanComment: Codable, Identifiable, Hashable {
    let id: String
    let blockId: String
    let anchorText: String
    var body: String
    let createdAt: Double
    var resolvedAt: Double?
    var sentAt: Double?
    let orphaned: Bool?
}

struct PlanCommentsPayload: Codable {
    let comments: [PlanComment]
}

struct PlanCommentPayload: Codable {
    let comment: PlanComment
}

struct PlanBlock: Identifiable, Hashable {
    enum Kind {
        case heading
        case list
        case code
        case quote
        case rule
        case table
        case paragraph
    }

    let id: String
    let text: String
    let kind: Kind
    let level: Int
    let checked: Bool?
    let line: Int
}

struct GitChanges: Codable, Hashable {
    let status: String
    let diff: String
    let branch: String
    let prUrl: String?
}

struct GitPushResult: Codable {
    let ok: Bool
    let branch: String
}

struct GitPRResult: Codable {
    let url: String
}

struct CodeSymbol: Codable, Identifiable, Hashable {
    var id: String { "\(path):\(line):\(name)" }
    let name: String
    let kind: String
    let file: String
    let line: Int
    let container: String?
    let root: String?
    let path: String
    let score: Double?
    /// The signature, when a language server supplied one.
    let detail: String?
}

struct DefinitionLookup: Codable {
    let candidates: [CodeSymbol]
    let indexed: Int?
    let truncated: Bool?
    /// "lsp", "index" or "none" — which layer answered.
    let source: String?
}

/// A position in a file, 1-based in both axes to match every line number in
/// AgentDock. `text` carries the unsaved buffer so a lookup resolves against
/// what the reader is looking at rather than what is on disk.
struct CodePosition: Codable {
    let path: String
    let line: Int
    let col: Int
    let roots: String
    let text: String?
}

struct CodeReference: Codable, Identifiable, Hashable {
    var id: String { "\(path):\(line):\(col ?? 1)" }
    let path: String
    let rel: String?
    let line: Int
    let col: Int?
    let text: String
}

struct ReferencesPayload: Codable {
    let hits: [CodeReference]
    let source: String?
}

struct HoverPayload: Codable {
    let text: String
    let source: String?
}

struct LanguageServerStatus: Codable, Identifiable, Hashable {
    var id: String { "\(serverId):\(root)" }
    let installed: Bool
    let running: Bool
    let warm: Bool
    let root: String
    let command: String
    let openDocuments: Int?
    let lastError: String?
    private let idField: String

    var serverId: String { idField }

    enum CodingKeys: String, CodingKey {
        case idField = "id"
        case installed, running, warm, root, command, openDocuments, lastError
    }
}

struct LanguageServerStatusPayload: Codable {
    let servers: [LanguageServerStatus]
}

struct DocumentSymbolsPayload: Codable {
    let symbols: [DocSymbol]
}

struct DocSymbol: Codable, Identifiable, Hashable {
    var id: String { "\(name):\(line)" }
    let name: String
    let kind: String
    let file: String
    let line: Int
    let container: String?
}

struct NavSpot: Hashable {
    let path: String
    let line: Int
    let external: Bool
}
