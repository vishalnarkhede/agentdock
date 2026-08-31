import AppKit
import SwiftUI

@MainActor
final class NativeSettingsModel: ObservableObject {
    @Published var preferences = NativePreferences()
    @Published var repositories: [RepositoryConfig] = []
    @Published var basePath = ""
    @Published var health: SettingsHealth?
    @Published var hooks: HookState?
    @Published var metaProperties: [MetaPropertyPreset] = []
    @Published var authStatus: AuthStatus?
    @Published var ngrokBasicAuthConfigured = false
    @Published var phoneLink: PhoneLink?
    @Published var languageServers: [LanguageServerStatus] = []
    @Published var loading = false
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?

    private let api = APIClient()
    private var loaded = false

    var theme: AgentDockTheme {
        AgentDockTheme.named(preferences.theme)
    }

    var chrome: AgentDockChrome {
        AgentDockChrome.named(preferences.fontSize)
    }

    var colorScheme: ColorScheme? {
        theme.colorScheme
    }

    var dynamicTypeSize: DynamicTypeSize {
        switch preferences.fontSize {
        case "small": .small
        case "large": .large
        default: .medium
        }
    }

    func load(force: Bool = false) async {
        guard force || !loaded else { return }
        loading = true
        defer {
            loading = false
            loaded = true
        }

        async let preferencesResult = capture { try await api.fetchPreferences() }
        async let repositoriesResult = capture { try await api.fetchSettingsRepositories() }
        async let basePathResult = capture { try await api.fetchBasePath() }
        async let healthResult = capture { try await api.fetchSettingsHealth() }
        async let hooksResult = capture { try await api.fetchHookState() }
        async let metaResult = capture { try await api.fetchMetaPropertyPresets() }
        async let authResult = capture { try await api.fetchAuthStatus() }
        async let ngrokResult = capture { try await api.fetchNgrokBasicAuthStatus() }
        async let phoneResult = capture { try await api.fetchPhoneLink() }
        async let serversResult = capture { try await api.fetchLanguageServers() }

        let results = await (
            preferencesResult,
            repositoriesResult,
            basePathResult,
            healthResult,
            hooksResult,
            metaResult,
            authResult,
            ngrokResult,
            phoneResult,
            serversResult
        )

        apply(results.0, to: \.preferences)
        apply(results.1, to: \.repositories)
        apply(results.2, to: \.basePath)
        applyOptional(results.3, to: \.health)
        applyOptional(results.4, to: \.hooks)
        apply(results.5, to: \.metaProperties)
        applyOptional(results.6, to: \.authStatus)
        apply(results.7, to: \.ngrokBasicAuthConfigured)
        applyOptional(results.8, to: \.phoneLink)
        apply(results.9, to: \.languageServers)
        applyLivePreferences()
    }

    func use(_ preferences: NativePreferences) {
        self.preferences = preferences
        applyLivePreferences()
    }

    func update<T>(
        _ keyPath: WritableKeyPath<NativePreferences, T>,
        key: String,
        value: T
    ) {
        var next = preferences
        next[keyPath: keyPath] = value
        preferences = next
        if key == "theme" {
            AgentDockTheme.applyAppAppearance(preferences.theme)
        }
        if ["terminalFontSize", "cursorBlink", "scrollback"].contains(key) {
            GhosttyRuntime.shared.applyPreferences(preferences)
        }
        Task {
            do {
                try await api.updatePreferences([key: value])
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    func saveBasePath(_ path: String) async -> Bool {
        await perform {
            try await api.updateBasePath(path)
            basePath = path
        }
    }

    func addRepository(alias: String, path: String, remote: String?) async -> Bool {
        await perform {
            try await api.addSettingsRepository(
                RepositoryConfig(alias: alias, path: path, remote: remote)
            )
            repositories = try await api.fetchSettingsRepositories()
        }
    }

    func deleteRepository(_ repository: RepositoryConfig) async -> Bool {
        await perform {
            try await api.deleteSettingsRepository(alias: repository.alias)
            repositories = try await api.fetchSettingsRepositories()
        }
    }

    func saveMetaProperties(_ presets: [MetaPropertyPreset]) async -> Bool {
        await perform {
            try await api.saveMetaPropertyPresets(presets)
            metaProperties = presets
        }
    }

    func installHooks() async {
        _ = await perform {
            hooks = try await api.installHooks()
            notice = "Claude status hooks installed."
        }
    }

    func refreshHealth() async {
        _ = await perform {
            async let nextHealth = api.fetchSettingsHealth()
            async let nextHooks = api.fetchHookState()
            health = try await nextHealth
            hooks = try await nextHooks
        }
        await refreshLanguageServers()
    }

    /// Language servers start on demand, so this is a snapshot rather than a
    /// fixed list: a server shows as idle until something in Files asks it.
    func refreshLanguageServers() async {
        languageServers = (try? await api.fetchLanguageServers()) ?? []
    }

    func refreshPhoneLink() async {
        _ = await perform {
            phoneLink = try await api.fetchPhoneLink()
        }
    }

    func setPassword(_ password: String) async -> Bool {
        await perform {
            try await api.setPassword(password)
            authStatus = AuthStatus(enabled: true, loggedIn: true)
            notice = "Password updated."
        }
    }

    func logout() async {
        _ = await perform {
            try await api.logout()
            authStatus = AuthStatus(enabled: true, loggedIn: false)
        }
    }

    func setNgrokBasicAuth(_ value: String) async -> Bool {
        await perform {
            try await api.setNgrokBasicAuth(value)
            ngrokBasicAuthConfigured = true
            notice = "Ngrok basic auth saved."
        }
    }

    func removeNgrokBasicAuth() async {
        _ = await perform {
            try await api.deleteNgrokBasicAuth()
            ngrokBasicAuthConfigured = false
            notice = "Ngrok basic auth removed."
        }
    }

    func copy(_ text: String, notice: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        self.notice = notice
    }

    private func perform(_ work: () async throws -> Void) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await work()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    private func applyLivePreferences() {
        AgentDockTheme.applyAppAppearance(preferences.theme)
        GhosttyRuntime.shared.applyPreferences(preferences)
    }

    private func capture<T>(_ work: () async throws -> T) async -> Result<T, Error> {
        do {
            return .success(try await work())
        } catch {
            return .failure(error)
        }
    }

    private func apply<T>(
        _ result: Result<T, Error>,
        to keyPath: ReferenceWritableKeyPath<NativeSettingsModel, T>
    ) {
        switch result {
        case let .success(value):
            self[keyPath: keyPath] = value
        case let .failure(error):
            // Settings panes remain useful when one optional endpoint fails.
            if self.error == nil { self.error = error.localizedDescription }
        }
    }

    private func applyOptional<T>(
        _ result: Result<T, Error>,
        to keyPath: ReferenceWritableKeyPath<NativeSettingsModel, T?>
    ) {
        switch result {
        case let .success(value):
            self[keyPath: keyPath] = value
        case let .failure(error):
            if self.error == nil { self.error = error.localizedDescription }
        }
    }
}
