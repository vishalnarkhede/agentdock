import AppKit
import SwiftUI

/// Native palette for each web `data-theme` id. Switching themes used to only
/// set `preferredColorScheme`, so cockpit / midnight / glass all looked the same.
struct AgentDockTheme: Equatable {
    var id: String
    var isLight: Bool
    var background: Color
    var chrome: Color
    var input: Color
    var hover: Color
    var text: Color
    var textDim: Color
    var textBright: Color
    var accent: Color
    var red: Color
    var green: Color
    var amber: Color
    var cyan: Color
    var border: Color

    var colorScheme: ColorScheme { isLight ? .light : .dark }

    var nsAppearance: NSAppearance? {
        NSAppearance(named: isLight ? .aqua : .darkAqua)
    }

    static func named(_ id: String) -> AgentDockTheme {
        palettes[id] ?? palettes["cockpit"]!
    }

    static func applyAppAppearance(_ id: String) {
        NSApp.appearance = named(id).nsAppearance
    }

    private static let palettes: [String: AgentDockTheme] = [
        "cockpit": .init(
            id: "cockpit", isLight: false,
            background: Color(hex: 0x0D1014), chrome: Color(hex: 0x12161C),
            input: Color(hex: 0x171B22), hover: Color(hex: 0x1E232C),
            text: Color(hex: 0x9AA4B6), textDim: Color(hex: 0x69748A),
            textBright: Color(hex: 0xDDE3EC), accent: Color(hex: 0x4A9EEA),
            red: Color(hex: 0xE08472), green: Color(hex: 0x3AAE72),
            amber: Color(hex: 0xC68E3A), cyan: Color(hex: 0x4A9EEA),
            border: Color(hex: 0x2A313C)
        ),
        "terminal": .init(
            id: "terminal", isLight: false,
            background: Color(hex: 0x0A0A0A), chrome: Color(hex: 0x0D1117),
            input: Color(hex: 0x111820), hover: Color(hex: 0x151D28),
            text: Color(hex: 0x33FF33), textDim: Color(hex: 0x1A8C1A),
            textBright: Color(hex: 0x66FF66), accent: Color(hex: 0x33FF33),
            red: Color(hex: 0xFF3333), green: Color(hex: 0x33FF33),
            amber: Color(hex: 0xFF9900), cyan: Color(hex: 0x00FFCC),
            border: Color(hex: 0x1A3A1A)
        ),
        "dark": .init(
            id: "dark", isLight: false,
            background: Color(hex: 0x18181B), chrome: Color(hex: 0x1F1F23),
            input: Color(hex: 0x27272A), hover: Color(hex: 0x2D2D31),
            text: Color(hex: 0xE4E4E7), textDim: Color(hex: 0x8A8A94),
            textBright: Color(hex: 0xFAFAFA), accent: Color(hex: 0x818CF8),
            red: Color(hex: 0xF87171), green: Color(hex: 0x4ADE80),
            amber: Color(hex: 0xFB923C), cyan: Color(hex: 0x22D3EE),
            border: Color(hex: 0x27272A)
        ),
        "midnight": .init(
            id: "midnight", isLight: false,
            background: Color(hex: 0x0D1117), chrome: Color(hex: 0x161B22),
            input: Color(hex: 0x0D1117), hover: Color(hex: 0x1C2333),
            text: Color(hex: 0xC9D1D9), textDim: Color(hex: 0x7D8590),
            textBright: Color(hex: 0xF0F6FC), accent: Color(hex: 0x58A6FF),
            red: Color(hex: 0xF85149), green: Color(hex: 0x3FB950),
            amber: Color(hex: 0xDB6D28), cyan: Color(hex: 0x39D2C0),
            border: Color(hex: 0x21262D)
        ),
        "glass": .init(
            id: "glass", isLight: false,
            background: Color(hex: 0x0F0F1A), chrome: Color(hex: 0x1A1A2E),
            input: Color(hex: 0x1A1A2E), hover: Color(hex: 0x252540),
            text: Color(hex: 0xE0E0EF), textDim: Color(hex: 0x6B6B8A),
            textBright: Color(hex: 0xF5F5FF), accent: Color(hex: 0xA78BFA),
            red: Color(hex: 0xFB7185), green: Color(hex: 0x4ADE80),
            amber: Color(hex: 0xFB923C), cyan: Color(hex: 0x22D3EE),
            border: Color(hex: 0x2A2A44)
        ),
        "light": .init(
            id: "light", isLight: true,
            background: Color(hex: 0xFAFAFA), chrome: Color(hex: 0xFFFFFF),
            input: Color(hex: 0xF4F4F5), hover: Color(hex: 0xE4E4E7),
            text: Color(hex: 0x18181B), textDim: Color(hex: 0x71717A),
            textBright: Color(hex: 0x09090B), accent: Color(hex: 0x6366F1),
            red: Color(hex: 0xEF4444), green: Color(hex: 0x15803D),
            amber: Color(hex: 0xEA580C), cyan: Color(hex: 0x0891B2),
            border: Color(hex: 0xE4E4E7)
        ),
        "minimal": .init(
            id: "minimal", isLight: true,
            background: Color(hex: 0xFAFAF9), chrome: Color(hex: 0xFFFFFF),
            input: Color(hex: 0xF5F5F4), hover: Color(hex: 0xEEEEEC),
            text: Color(hex: 0x1C1C1C), textDim: Color(hex: 0x6E6E6B),
            textBright: Color(hex: 0x0A0A0A), accent: Color(hex: 0x6B7280),
            red: Color(hex: 0xDC2626), green: Color(hex: 0x16A34A),
            amber: Color(hex: 0xEA580C), cyan: Color(hex: 0x0284C7),
            border: Color(hex: 0xE5E5E5)
        ),
        "notion": .init(
            id: "notion", isLight: true,
            background: Color(hex: 0xF7F6F3), chrome: Color(hex: 0xFFFFFF),
            input: Color(hex: 0xF0EFEB), hover: Color(hex: 0xEAE8E3),
            text: Color(hex: 0x37352F), textDim: Color(hex: 0x6B6A66),
            textBright: Color(hex: 0x1A1A1A), accent: Color(hex: 0xB4856D),
            red: Color(hex: 0xE03E3E), green: Color(hex: 0x0F7B6C),
            amber: Color(hex: 0xD9730D), cyan: Color(hex: 0x0B6E99),
            border: Color(hex: 0xE3E2DE)
        ),
        "macos": .init(
            id: "macos", isLight: true,
            background: Color(hex: 0xF5F5F7), chrome: Color(hex: 0xFFFFFF),
            input: Color(hex: 0xFFFFFF), hover: Color(hex: 0xE8E8ED),
            text: Color(hex: 0x1D1D1F), textDim: Color(hex: 0x6E6E73),
            textBright: Color(hex: 0x000000), accent: Color(hex: 0x007AFF),
            red: Color(hex: 0xFF3B30), green: Color(hex: 0x28CD41),
            amber: Color(hex: 0xFF9500), cyan: Color(hex: 0x5AC8FA),
            border: Color(hex: 0xD2D2D7)
        ),
        "win98": .init(
            id: "win98", isLight: true,
            background: Color(hex: 0xC0C0C0), chrome: Color(hex: 0xC0C0C0),
            input: Color(hex: 0xFFFFFF), hover: Color(hex: 0x000080),
            text: Color(hex: 0x000000), textDim: Color(hex: 0x4A4A4A),
            textBright: Color(hex: 0x000000), accent: Color(hex: 0x000080),
            red: Color(hex: 0xFF0000), green: Color(hex: 0x005A00),
            amber: Color(hex: 0x8A4B00), cyan: Color(hex: 0x005E5E),
            border: Color(hex: 0x808080)
        ),
    ]
}

struct AgentDockChrome: Equatable {
    var id: String
    var body: CGFloat
    var caption: CGFloat
    var mono: CGFloat

    static func named(_ fontSize: String) -> AgentDockChrome {
        switch fontSize {
        case "small": .init(id: "small", body: 12, caption: 10, mono: 12)
        case "large": .init(id: "large", body: 16, caption: 13, mono: 15)
        default: .init(id: "medium", body: 13, caption: 11, mono: 13)
        }
    }
}

private struct AgentDockThemeKey: EnvironmentKey {
    static let defaultValue = AgentDockTheme.named("cockpit")
}

private struct AgentDockChromeKey: EnvironmentKey {
    static let defaultValue = AgentDockChrome.named("medium")
}

extension EnvironmentValues {
    var agentDockTheme: AgentDockTheme {
        get { self[AgentDockThemeKey.self] }
        set { self[AgentDockThemeKey.self] = newValue }
    }

    var agentDockChrome: AgentDockChrome {
        get { self[AgentDockChromeKey.self] }
        set { self[AgentDockChromeKey.self] = newValue }
    }
}

extension View {
    func agentDockThemed(_ theme: AgentDockTheme, chrome: AgentDockChrome) -> some View {
        self
            .environment(\.agentDockTheme, theme)
            .environment(\.agentDockChrome, chrome)
            .environment(\.font, Font.system(size: chrome.body))
            .preferredColorScheme(theme.colorScheme)
            .tint(theme.accent)
            .background(theme.background)
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}
