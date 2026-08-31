import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var sessions: [AgentSession] = []
    @Published var selectedSessionID: String?
    @Published var errorMessage: String?
    @Published private(set) var serverReady = false
    @Published var needsAuthentication = false
    @Published var showingCreateSession = false
    @Published private(set) var pinnedSessions: Set<String> = []
    @Published var groupBy = "__queue__"
    @Published var sortBy = ""
    @Published var collapsedGroups: Set<String> = []
    @Published private(set) var repositories: [RepositoryConfig] = []
    let terminals = TerminalSurfaceStore()
    let files = FileExplorerStateStore()
    let plans = PlanStateStore()
    let changes = ChangesStateStore()
    let settings = NativeSettingsModel()
    private let notifications = NativeNotificationController()

    private let api = APIClient()
    private lazy var supervisor = ServerSupervisor(api: api)
    private var refreshTask: Task<Void, Never>?
    private var tabsBySession: [String: WorkspaceTab] = [:]
    private var terminationObserver: NSObjectProtocol?

    var selectedSession: AgentSession? {
        sessions.first { $0.id == selectedSessionID }
    }

    var queueCounts: NativeQueueCounts {
        NativeQueue.counts(sessions)
    }

    var blockedSessions: [AgentSession] {
        NativeQueue.topLevel(sessions).filter { NativeQueue.bucket($0) == .blocked }
    }

    var staleSessions: [AgentSession] {
        NativeQueue.topLevel(sessions).filter { NativeQueue.bucket($0) == .stale }
    }

    func start() async {
        guard refreshTask == nil else { return }
        notifications.onOpenSession = { [weak self] name in
            self?.selectSession(name)
        }
        observeTermination()
        do {
            try await supervisor.ensureRunning()
            serverReady = true
            await loadPreferences()
            await loadRepositories()
            await settings.load()
            await refresh()
            refreshTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    await self?.refresh()
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Only a server this app started is stopped; an already running one keeps going.
    private func observeTermination() {
        guard terminationObserver == nil else { return }
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.supervisor.stopOwnedServer()
            }
        }
    }

    func refresh() async {
        do {
            let latest = try await api.fetchSessions()
            sessions = latest
            notifications.update(
                sessions: latest,
                activeSession: selectedSessionID,
                preferences: settings.preferences
            )
            needsAuthentication = false
            if selectedSessionID == nil || !latest.contains(where: { $0.id == selectedSessionID }) {
                selectedSessionID = NativeQueue.firstAttention(in: latest)?.id
            }
            errorMessage = nil
        } catch APIError.unauthorized {
            needsAuthentication = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectSession(_ name: String) {
        selectedSessionID = name
        recordUsage(name)
    }

    func togglePin(_ name: String) {
        if pinnedSessions.contains(name) {
            pinnedSessions.remove(name)
        } else {
            pinnedSessions.insert(name)
        }
        Task {
            try? await api.updatePreferences(["pinnedSessions": Array(pinnedSessions)])
        }
    }

    func toggleGroup(_ name: String) {
        if collapsedGroups.contains(name) {
            collapsedGroups.remove(name)
        } else {
            collapsedGroups.insert(name)
        }
        Task {
            try? await api.updatePreferences(["collapsedGroups": Array(collapsedGroups)])
        }
    }

    func setGrouping(_ value: String) {
        groupBy = value
        sortBy = ""
        Task {
            try? await api.updatePreferences(["groupBy": value, "sortBy": ""])
        }
    }

    func setSorting(_ value: String) {
        sortBy = value
        Task {
            try? await api.updatePreferences(["sortBy": value])
        }
    }

    func deleteSession(_ session: AgentSession) async {
        do {
            try await api.deleteSession(session.name)
            terminals.remove(sessionID: session.id)
            files.remove(sessionID: session.id)
            plans.remove(sessionID: session.id)
            changes.remove(sessionID: session.id)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func restoreSession(_ session: AgentSession) async {
        do {
            try await api.restoreSession(session.name)
            await refresh()
            selectSession(session.name)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func renameSession(_ session: AgentSession, to displayName: String) async {
        do {
            let result = try await api.renameSession(session.name, to: displayName)
            if selectedSessionID == session.name {
                selectedSessionID = result.name
            }
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func openInITerm(_ session: AgentSession) async {
        do {
            try await api.openInITerm(session.name)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func switchAgent(_ session: AgentSession) async {
        do {
            let next = session.agentType == "cursor" ? "claude" : "cursor"
            try await api.switchAgent(session.name, to: next)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createSession(_ payload: CreateSessionPayload) async -> Bool {
        do {
            let created = try await api.createSession(payload)
            await refresh()
            if let first = created.sessions.first {
                selectSession(first)
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func login(password: String) async -> Bool {
        do {
            try await api.login(password: password)
            needsAuthentication = false
            await refresh()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func tab(for sessionID: String) -> WorkspaceTab {
        tabsBySession[sessionID] ?? .terminal
    }

    func select(tab: WorkspaceTab, for sessionID: String) {
        tabsBySession[sessionID] = tab
        objectWillChange.send()
    }

    func selectTabForCurrentSession(_ tab: WorkspaceTab) {
        guard let selectedSessionID else { return }
        select(tab: tab, for: selectedSessionID)
    }

    func selectAdjacentSession(offset: Int) {
        guard !sessions.isEmpty else { return }
        guard let current = sessions.firstIndex(where: { $0.id == selectedSessionID }) else {
            selectedSessionID = sessions.first?.id
            return
        }
        let next = (current + offset + sessions.count) % sessions.count
        selectSession(sessions[next].id)
    }

    func selectNextQueueItem() {
        guard let next = NativeQueue.next(in: sessions, after: selectedSessionID) else { return }
        selectSession(next.id)
    }

    /// Same as the web terminal drop: type each file path into the agent.
    func sendDroppedFiles(_ urls: [URL], to session: AgentSession) {
        let text = SessionFileDrop.input(from: urls)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if terminals.view(for: session).insertDroppedFiles(urls) {
            return
        }
        Task {
            do {
                try await api.sendInput(text, to: session.name)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Reveal a path in the Files tab, so a diff line or a plan reference lands
    /// in the editor with its history and code intelligence.
    func openInFiles(path: String, line: Int?) {
        guard let session = selectedSession else { return }
        let files = files.model(for: session)
        select(tab: .files, for: session.id)
        Task { await files.open(path, line: line) }
    }

    func navigateEditorBack() {
        guard let session = selectedSession else { return }
        Task { await files.model(for: session).goBack() }
    }

    func navigateEditorForward() {
        guard let session = selectedSession else { return }
        Task { await files.model(for: session).goForward() }
    }

    func jumpToEditorDefinition() {
        guard let session = selectedSession else { return }
        Task { await files.model(for: session).jumpToSymbolAtCursor() }
    }

    private func loadPreferences() async {
        guard let preferences = try? await api.fetchPreferences() else { return }
        settings.use(preferences)
        pinnedSessions = Set(preferences.pinnedSessions)
        groupBy = preferences.groupBy ?? "__queue__"
        sortBy = preferences.sortBy ?? ""
        collapsedGroups = Set(preferences.collapsedGroups)
        usage = preferences.sessionStats
    }

    func loadRepositories() async {
        repositories = (try? await api.fetchRepositories()) ?? []
    }

    private var usage: [String: NativePreferences.SessionUsage] = [:]

    private func recordUsage(_ name: String) {
        var current = usage[name] ?? .init(count: 0, last: 0)
        current.count += 1
        current.last = Date().timeIntervalSince1970 * 1000
        usage[name] = current
        let encoded = usage.mapValues { ["count": $0.count, "last": $0.last] }
        Task {
            try? await api.updatePreferences(["sessionStats": encoded])
        }
    }
}
