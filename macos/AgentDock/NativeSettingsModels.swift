import Foundation

struct ToolHealth: Codable, Hashable {
    let installed: Bool
    let version: String
}

struct SettingsHealth: Codable {
    let tmux: ToolHealth
    let claude: ToolHealth
    let cursor: ToolHealth
    let git: ToolHealth
    let gh: ToolHealth
    let bun: ToolHealth
    let psql: ToolHealth
}

struct HookState: Codable {
    struct Event: Codable, Identifiable {
        var id: String { event }
        let event: String
        let status: String
        let means: String
    }

    let installed: [String]
    let missing: [String]
    let ok: Bool
    let settingsPath: String
    let scriptPath: String
    let events: [Event]?
}

struct MetaPropertyPreset: Codable, Identifiable, Hashable {
    var id: String { key }
    let key: String
    var label: String
    var values: [String]
}

struct AuthStatus: Codable {
    let enabled: Bool
    let loggedIn: Bool
}

struct PhoneAddress: Codable, Identifiable, Hashable {
    var id: String { "\(host):\(iface)" }
    let host: String
    let iface: String
    let kind: String
    let note: String
}

struct PhonePort: Codable, Hashable {
    let port: Int
    let scheme: String
}

struct PhoneLink: Codable {
    let addresses: [PhoneAddress]
    let ports: [PhonePort]
    let url: String?
    let problem: String?
}
