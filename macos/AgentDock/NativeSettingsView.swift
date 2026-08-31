import AppKit
import CoreImage.CIFilterBuiltins
import SwiftUI
import UserNotifications

private enum SettingsCategory: String, CaseIterable, Identifiable {
    case repositories
    case agents
    case notifications
    case worktrees
    case properties
    case access
    case appearance
    case terminal
    case health
    case shortcuts

    var id: String { rawValue }

    var title: String {
        switch self {
        case .repositories: "Repositories"
        case .agents: "Agents"
        case .notifications: "Notifications"
        case .worktrees: "Worktrees"
        case .properties: "Session properties"
        case .access: "Access"
        case .appearance: "Appearance"
        case .terminal: "Terminal"
        case .health: "Health"
        case .shortcuts: "Shortcuts"
        }
    }

    var icon: String {
        switch self {
        case .repositories: "folder"
        case .agents: "sparkles"
        case .notifications: "bell"
        case .worktrees: "arrow.triangle.branch"
        case .properties: "line.3.horizontal.decrease.circle"
        case .access: "lock"
        case .appearance: "eye"
        case .terminal: "terminal"
        case .health: "stethoscope"
        case .shortcuts: "keyboard"
        }
    }

    var blurb: String {
        switch self {
        case .repositories: "The repositories AgentDock offers when you start a session."
        case .agents: "Which CLI runs, and with what permission policy."
        case .notifications: "Interrupt only when an agent needs you or is ready to review."
        case .worktrees: "Where isolated checkouts go and how they are prepared."
        case .properties: "Your own labels for grouping sessions—priority, customer, team."
        case .access: "Network addresses, the AgentDock password, and ngrok protection."
        case .appearance: "Dashboard theme and interface type size."
        case .terminal: "Web terminal preferences and the native Ghostty configuration."
        case .health: "External tools and Claude lifecycle hooks."
        case .shortcuts: "Keyboard shortcuts available in the native app."
        }
    }
}

struct NativeSettingsView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.agentDockTheme) private var theme
    @State private var category: SettingsCategory = .repositories

    var body: some View {
        NavigationSplitView {
            List(SettingsCategory.allCases, selection: $category) { item in
                Label(item.title, systemImage: item.icon)
                    .tag(item)
                    .listRowBackground(theme.background)
            }
            .scrollContentBackground(.hidden)
            .background(theme.background)
            .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 250)
        } detail: {
            SettingsDetail(category: category, model: app.settings)
                .environmentObject(app)
        }
        .task { await app.settings.load() }
        .alert(
            "Settings",
            isPresented: Binding(
                get: { app.settings.error != nil },
                set: { if !$0 { app.settings.error = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(app.settings.error ?? "")
        }
        .overlay(alignment: .bottom) {
            if let notice = app.settings.notice {
                Text(notice)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(.regularMaterial, in: Capsule())
                    .padding()
                    .onTapGesture { app.settings.notice = nil }
            }
        }
    }
}

private struct SettingsDetail: View {
    @Environment(\.agentDockTheme) private var theme
    let category: SettingsCategory
    @ObservedObject var model: NativeSettingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(category.title)
                    .font(.title2.bold())
                Text(category.blurb)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 24)
            .padding(.top, 22)
            .padding(.bottom, 14)

            Divider()

            Group {
                switch category {
                case .repositories: RepositoriesSettings(model: model)
                case .agents: AgentSettings(model: model)
                case .notifications: NotificationSettings(model: model)
                case .worktrees: WorktreeSettings(model: model)
                case .properties: MetaPropertySettings(model: model)
                case .access: AccessSettings(model: model)
                case .appearance: AppearanceSettings(model: model)
                case .terminal: TerminalSettings(model: model)
                case .health: HealthSettings(model: model)
                case .shortcuts: ShortcutSettings()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(theme.background)
        .foregroundStyle(theme.text)
    }
}

// MARK: - Shared controls

private struct SettingsPage<Content: View>: View {
    @Environment(\.agentDockTheme) private var theme
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                content
            }
            .padding(24)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(theme.background)
    }
}

private struct SettingsSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
            content
        }
    }
}

private struct ThemeSwatch: View {
    let color: Color
    let title: String

    var body: some View {
        VStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 5)
                .fill(color)
                .frame(width: 36, height: 22)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(.quaternary))
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

private struct SettingHint: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct SettingsCard<Content: View>: View {
    @Environment(\.agentDockTheme) private var theme
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.input, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(theme.border))
    }
}

// MARK: - Repositories

private struct RepositoriesSettings: View {
    @EnvironmentObject private var app: AppModel
    @ObservedObject var model: NativeSettingsModel
    @State private var editingBase = false
    @State private var basePath = ""
    @State private var adding = false
    @State private var alias = ""
    @State private var path = ""
    @State private var remote = ""

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Base path") {
                SettingsCard {
                    if editingBase {
                        TextField("/Users/you/projects", text: $basePath)
                            .textFieldStyle(.roundedBorder)
                        HStack {
                            Button("Cancel") {
                                basePath = model.basePath
                                editingBase = false
                            }
                            Button("Save") {
                                Task {
                                    if await model.saveBasePath(basePath) {
                                        editingBase = false
                                    }
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(basePath.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    } else {
                        HStack {
                            Image(systemName: "folder")
                            Text(model.basePath.isEmpty ? "Not configured" : model.basePath)
                                .font(.body.monospaced())
                                .textSelection(.enabled)
                            Spacer()
                            Button("Edit") {
                                basePath = model.basePath
                                editingBase = true
                            }
                        }
                    }
                    SettingHint(text: "Repository scanning and isolated worktrees use this common parent directory.")
                }
            }

            SettingsSection(title: "Repositories") {
                HStack {
                    Text("\(model.repositories.count) configured")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(adding ? "Cancel" : "Add repository") {
                        adding.toggle()
                    }
                }

                if adding {
                    SettingsCard {
                        TextField("Alias (for example, my-app)", text: $alias)
                        TextField("Absolute path", text: $path)
                        TextField("Remote URL (optional)", text: $remote)
                        HStack {
                            Spacer()
                            Button("Add") {
                                let cleanRemote = remote.trimmingCharacters(in: .whitespacesAndNewlines)
                                Task {
                                    if await model.addRepository(
                                        alias: alias.trimmingCharacters(in: .whitespacesAndNewlines),
                                        path: path.trimmingCharacters(in: .whitespacesAndNewlines),
                                        remote: cleanRemote.isEmpty ? nil : cleanRemote
                                    ) {
                                        alias = ""
                                        path = ""
                                        remote = ""
                                        adding = false
                                        await app.loadRepositories()
                                    }
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(alias.trimmingCharacters(in: .whitespaces).isEmpty
                                || path.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                    .textFieldStyle(.roundedBorder)
                }

                ForEach(model.repositories) { repository in
                    SettingsCard {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(repository.alias).fontWeight(.semibold)
                                Text(repository.path)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                                if let remote = repository.remote, !remote.isEmpty {
                                    Text(remote)
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                        .textSelection(.enabled)
                                }
                            }
                            Spacer()
                            Button("Remove", role: .destructive) {
                                Task {
                                    if await model.deleteRepository(repository) {
                                        await app.loadRepositories()
                                    }
                                }
                            }
                        }
                    }
                }

                if model.repositories.isEmpty {
                    ContentUnavailableView(
                        "No repositories configured",
                        systemImage: "folder.badge.plus"
                    )
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }
}

// MARK: - Agents

private struct AgentSettings: View {
    @ObservedObject var model: NativeSettingsModel

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Default for new sessions") {
                Picker("Agent", selection: stringBinding(\.defaultAgent, "defaultAgent")) {
                    Text("Claude Code").tag("claude")
                    Text("Cursor Agent").tag("cursor")
                }
                .pickerStyle(.segmented)

                Toggle(
                    "Start without permission prompts",
                    isOn: boolBinding(\.defaultSkipPermissions, "defaultSkipPermissions")
                )
                SettingHint(text: skipHint)
            }

            SettingsSection(title: "What actually runs") {
                agentCard(
                    title: "Claude Code",
                    command: model.preferences.defaultSkipPermissions
                        ? "claude --dangerously-skip-permissions"
                        : "claude --allowedTools …",
                    health: model.health?.claude,
                    selected: model.preferences.defaultAgent == "claude"
                )
                agentCard(
                    title: "Cursor Agent",
                    command: model.preferences.defaultSkipPermissions ? "agent --yolo" : "agent",
                    health: model.health?.cursor,
                    selected: model.preferences.defaultAgent == "cursor"
                )
                SettingHint(text: "Claude also receives AgentDock's system prompt and additional worktree directories. Cursor runs in the first worktree.")
            }
        }
    }

    private var skipHint: String {
        model.preferences.defaultAgent == "cursor"
            ? "Passes --yolo to new Cursor sessions."
            : "Passes --dangerously-skip-permissions. Otherwise Claude uses AgentDock's fixed allow-list."
    }

    private func agentCard(
        title: String,
        command: String,
        health: ToolHealth?,
        selected: Bool
    ) -> some View {
        SettingsCard {
            HStack {
                Circle()
                    .fill(health?.installed == true ? .green : .red)
                    .frame(width: 8, height: 8)
                Text(title).fontWeight(.semibold)
                if selected {
                    Text("default")
                        .font(.caption2.bold())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.tint.opacity(0.15), in: Capsule())
                }
                Spacer()
                Text(health?.version ?? "checking…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(command)
                .font(.caption.monospaced())
                .textSelection(.enabled)
        }
    }

    private func stringBinding(
        _ path: WritableKeyPath<NativePreferences, String>,
        _ key: String
    ) -> Binding<String> {
        Binding(
            get: { model.preferences[keyPath: path] },
            set: { model.update(path, key: key, value: $0) }
        )
    }

    private func boolBinding(
        _ path: WritableKeyPath<NativePreferences, Bool>,
        _ key: String
    ) -> Binding<Bool> {
        Binding(
            get: { model.preferences[keyPath: path] },
            set: { model.update(path, key: key, value: $0) }
        )
    }
}

// MARK: - Notifications

private struct NotificationSettings: View {
    @ObservedObject var model: NativeSettingsModel
    @State private var testStatus = ""

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Events") {
                Toggle("Enable notifications", isOn: binding(\.notificationsEnabled, "notificationsEnabled"))
                Toggle("An agent starts waiting on you", isOn: binding(\.notifyBlocked, "notifyBlocked"))
                    .disabled(!model.preferences.notificationsEnabled)
                SettingHint(text: "It asked a question or needs permission and cannot continue.")
                Toggle("An agent becomes reviewable", isOn: binding(\.notifyReview, "notifyReview"))
                    .disabled(!model.preferences.notificationsEnabled)
                SettingHint(text: "It finished its turn and the result is ready to inspect.")
            }

            SettingsSection(title: "Delivery") {
                Toggle("Stay quiet overnight", isOn: binding(\.notifyQuietEnabled, "notifyQuietEnabled"))
                    .disabled(!model.preferences.notificationsEnabled)
                HStack {
                    Picker("From", selection: intBinding(\.notifyQuietStart, "notifyQuietStart")) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(String(format: "%02d:00", hour)).tag(hour)
                        }
                    }
                    Picker("To", selection: intBinding(\.notifyQuietEnd, "notifyQuietEnd")) {
                        ForEach(0..<24, id: \.self) { hour in
                            Text(String(format: "%02d:00", hour)).tag(hour)
                        }
                    }
                }
                .disabled(!model.preferences.notificationsEnabled || !model.preferences.notifyQuietEnabled)

                Toggle("Hold notifications for 30 seconds", isOn: binding(\.notifyBatchEnabled, "notifyBatchEnabled"))
                    .disabled(!model.preferences.notificationsEnabled)
                SettingHint(text: "Agents finishing together arrive as one notification.")

                Toggle("Keep reminding me about blocked agents", isOn: binding(\.notifyRemindEnabled, "notifyRemindEnabled"))
                    .disabled(!model.preferences.notificationsEnabled)
                SettingHint(text: "Re-notify every 15 minutes until the agent is answered.")
            }

            SettingsSection(title: "Test") {
                HStack {
                    Button("Send test notification") { sendTest() }
                        .disabled(!model.preferences.notificationsEnabled)
                    if !testStatus.isEmpty {
                        Text(testStatus)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                SettingHint(text: "macOS may also require notifications to be enabled for AgentDock in System Settings.")
            }
        }
    }

    private func binding(
        _ path: WritableKeyPath<NativePreferences, Bool>,
        _ key: String
    ) -> Binding<Bool> {
        Binding(
            get: { model.preferences[keyPath: path] },
            set: { model.update(path, key: key, value: $0) }
        )
    }

    private func intBinding(
        _ path: WritableKeyPath<NativePreferences, Int>,
        _ key: String
    ) -> Binding<Int> {
        Binding(
            get: { model.preferences[keyPath: path] },
            set: { model.update(path, key: key, value: $0) }
        )
    }

    private func sendTest() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            DispatchQueue.main.async {
                if let error {
                    testStatus = error.localizedDescription
                } else if !granted {
                    testStatus = "Permission denied"
                } else {
                    let content = UNMutableNotificationContent()
                    content.title = "AgentDock"
                    content.body = "Notifications are working."
                    content.sound = .default
                    let request = UNNotificationRequest(identifier: "settings-test", content: content, trigger: nil)
                    UNUserNotificationCenter.current().add(request)
                    testStatus = "Sent"
                }
            }
        }
    }
}

// MARK: - Worktrees

private struct WorktreeSettings: View {
    @ObservedObject var model: NativeSettingsModel
    @State private var command = ""
    @State private var prefix = ""

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Where they go") {
                SettingsCard {
                    Label(
                        "\(model.basePath.isEmpty ? "…" : model.basePath)/.worktrees/<session>/<repo>",
                        systemImage: "folder"
                    )
                    .font(.body.monospaced())
                    SettingHint(text: "The base path is shared with repository scanning. Change it under Repositories.")
                }
            }

            SettingsSection(title: "After creation") {
                TextField("Post-create command, for example bun install", text: $command)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { commitCommand() }
                    .onChange(of: command) { _, _ in }
                SettingHint(text: "Runs once in each new worktree before the agent starts.")
                Button("Save command", action: commitCommand)
                    .disabled(command == model.preferences.worktreePostCreate)
            }

            SettingsSection(title: "Naming") {
                TextField("Branch prefix", text: $prefix)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260)
                    .onSubmit { commitPrefix() }
                SettingHint(text: "Non-ticket sessions use \((prefix.isEmpty ? "wt-" : prefix))<short id>.")
                Button("Save prefix", action: commitPrefix)
                    .disabled(prefix == model.preferences.worktreeBranchPrefix)
            }

            SettingsSection(title: "Cleanup") {
                Toggle(
                    "Remove the worktree after a clean merge",
                    isOn: Binding(
                        get: { model.preferences.worktreeAutoRemove },
                        set: { model.update(\.worktreeAutoRemove, key: "worktreeAutoRemove", value: $0) }
                    )
                )
                SettingHint(text: "Saved for the worktree cleaner. Deleting a session already removes its checkout. Automatic merge cleanup is not running in the background yet.")
            }
        }
        .onAppear {
            command = model.preferences.worktreePostCreate
            prefix = model.preferences.worktreeBranchPrefix
        }
    }

    private func commitCommand() {
        model.update(\.worktreePostCreate, key: "worktreePostCreate", value: command)
    }

    private func commitPrefix() {
        model.update(\.worktreeBranchPrefix, key: "worktreeBranchPrefix", value: prefix)
    }
}

// MARK: - Meta properties

private struct MetaPropertySettings: View {
    @ObservedObject var model: NativeSettingsModel
    @State private var editing: MetaPropertyPreset?
    @State private var adding = false
    @State private var key = ""
    @State private var label = ""
    @State private var values = ""

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Properties") {
                SettingHint(text: "Preset values become menus when assigning properties to sessions. Leave values empty for free text.")
                HStack {
                    Text("\(model.metaProperties.count) configured")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(adding ? "Cancel" : "Add property") {
                        adding.toggle()
                        editing = nil
                        reset()
                    }
                }

                if adding || editing != nil {
                    SettingsCard {
                        if editing == nil {
                            TextField("Key (for example, customer)", text: $key)
                        } else {
                            LabeledContent("Key", value: editing?.key ?? "")
                        }
                        TextField("Label", text: $label)
                        TextField("Preset values, comma-separated", text: $values)
                        HStack {
                            Button("Cancel") {
                                adding = false
                                editing = nil
                                reset()
                            }
                            Button(editing == nil ? "Add" : "Save") { save() }
                                .buttonStyle(.borderedProminent)
                                .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty
                                    || (editing == nil && key.trimmingCharacters(in: .whitespaces).isEmpty))
                        }
                    }
                    .textFieldStyle(.roundedBorder)
                }

                ForEach(model.metaProperties) { preset in
                    SettingsCard {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(preset.label).fontWeight(.semibold)
                                Text(preset.values.isEmpty ? "Free text" : preset.values.joined(separator: ", "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text("key: \(preset.key)")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.tertiary)
                            }
                            Spacer()
                            Button("Edit") {
                                editing = preset
                                adding = false
                                label = preset.label
                                values = preset.values.joined(separator: ", ")
                            }
                            Button("Remove", role: .destructive) {
                                Task {
                                    _ = await model.saveMetaProperties(
                                        model.metaProperties.filter { $0.key != preset.key }
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func save() {
        let parsedValues = values.split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }.filter { !$0.isEmpty }
        var next = model.metaProperties
        if let editing, let index = next.firstIndex(where: { $0.key == editing.key }) {
            next[index] = MetaPropertyPreset(key: editing.key, label: label.trimmingCharacters(in: .whitespaces), values: parsedValues)
        } else {
            let normalizedKey = key
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
                .replacingOccurrences(of: #"\s+"#, with: "_", options: .regularExpression)
            next.append(MetaPropertyPreset(key: normalizedKey, label: label.trimmingCharacters(in: .whitespaces), values: parsedValues))
        }
        Task {
            if await model.saveMetaProperties(next) {
                adding = false
                self.editing = nil
                reset()
            }
        }
    }

    private func reset() {
        key = ""
        label = ""
        values = ""
    }
}

// MARK: - Access

private struct AccessSettings: View {
    @ObservedObject var model: NativeSettingsModel
    @State private var addressIndex = 0
    @State private var password = ""
    @State private var confirmation = ""
    @State private var ngrokAuth = ""

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Open on your phone") {
                if let link = model.phoneLink {
                    if let url = phoneURL(link) {
                        SettingsCard {
                            HStack(alignment: .top, spacing: 16) {
                                NativeQRCode(value: url)
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(url)
                                        .font(.body.monospaced())
                                        .textSelection(.enabled)
                                    if link.addresses.indices.contains(addressIndex) {
                                        Text(link.addresses[addressIndex].note)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    HStack {
                                        Button("Copy link") { model.copy(url, notice: "Copied phone link.") }
                                        Button("Open here") {
                                            if let parsed = URL(string: url) { NSWorkspace.shared.open(parsed) }
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        Label(link.problem ?? "No reachable address found.", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.secondary)
                    }

                    if link.addresses.count > 1 {
                        Picker("Network", selection: $addressIndex) {
                            ForEach(Array(link.addresses.enumerated()), id: \.offset) { index, address in
                                Text("\(address.host) · \(address.note)").tag(index)
                            }
                        }
                    }
                } else {
                    ProgressView("Reading network…")
                }
                Button("Refresh network") { Task { await model.refreshPhoneLink() } }
            }

            SettingsSection(title: "AgentDock password") {
                SettingHint(text: model.authStatus?.enabled == true
                    ? "Authentication is enabled. Set a new password below."
                    : "Set a password before exposing AgentDock outside your local machine.")
                SecureField(model.authStatus?.enabled == true ? "New password" : "Choose a password", text: $password)
                    .textFieldStyle(.roundedBorder)
                SecureField("Confirm password", text: $confirmation)
                    .textFieldStyle(.roundedBorder)
                if !confirmation.isEmpty, password != confirmation {
                    Text("Passwords do not match.")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                HStack {
                    Button(model.authStatus?.enabled == true ? "Change password" : "Set password") {
                        Task {
                            if await model.setPassword(password) {
                                password = ""
                                confirmation = ""
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(password.count < 4 || password != confirmation)
                    if model.authStatus?.enabled == true {
                        Button("Log out", role: .destructive) { Task { await model.logout() } }
                    }
                }
            }

            SettingsSection(title: "Ngrok basic auth") {
                SettingHint(text: model.ngrokBasicAuthConfigured
                    ? "Configured. Update it below or remove it."
                    : "Optionally add a second HTTP basic-auth prompt to the public tunnel.")
                TextField("user:password", text: $ngrokAuth)
                    .textFieldStyle(.roundedBorder)
                HStack {
                    Button(model.ngrokBasicAuthConfigured ? "Update" : "Save") {
                        Task {
                            if await model.setNgrokBasicAuth(ngrokAuth) { ngrokAuth = "" }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!ngrokAuth.contains(":"))
                    if model.ngrokBasicAuthConfigured {
                        Button("Remove", role: .destructive) {
                            Task { await model.removeNgrokBasicAuth() }
                        }
                    }
                }
            }
        }
    }

    private func phoneURL(_ link: PhoneLink) -> String? {
        guard link.addresses.indices.contains(addressIndex),
              let port = link.ports.first(where: { $0.scheme == "http" })
        else { return link.url }
        return "http://\(link.addresses[addressIndex].host):\(port.port)"
    }
}

private struct NativeQRCode: View {
    let value: String
    private let context = CIContext()
    private let filter = CIFilter.qrCodeGenerator()

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
            } else {
                Image(systemName: "qrcode")
                    .resizable()
                    .padding(12)
            }
        }
        .frame(width: 104, height: 104)
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }

    private var image: NSImage? {
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cgImage = context.createCGImage(output, from: output.extent)
        else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: 104, height: 104))
    }
}

// MARK: - Appearance and terminal

private struct AppearanceSettings: View {
    @ObservedObject var model: NativeSettingsModel
    @Environment(\.agentDockTheme) private var theme
    private let themes = [
        ("cockpit", "Cockpit"), ("terminal", "Terminal"), ("dark", "Dark"),
        ("midnight", "Midnight"), ("light", "Light"), ("minimal", "Minimal"),
        ("glass", "Glass"), ("notion", "Notion"), ("macos", "macOS"),
        ("win98", "Windows 98"),
    ]

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Theme") {
                Picker("Theme", selection: Binding(
                    get: { model.preferences.theme },
                    set: { model.update(\.theme, key: "theme", value: $0) }
                )) {
                    ForEach(themes, id: \.0) { theme in
                        Text(theme.1).tag(theme.0)
                    }
                }
                .frame(maxWidth: 300)
                HStack(spacing: 8) {
                    ThemeSwatch(color: theme.background, title: "Background")
                    ThemeSwatch(color: theme.chrome, title: "Chrome")
                    ThemeSwatch(color: theme.accent, title: "Accent")
                    ThemeSwatch(color: theme.green, title: "Ready")
                    ThemeSwatch(color: theme.amber, title: "Waiting")
                }
                SettingHint(text: "Same theme list as the web dashboard. Sidebar, bars, accent, and the editor follow this palette immediately.")
            }

            SettingsSection(title: "Interface size") {
                Picker("Font size", selection: Binding(
                    get: { model.preferences.fontSize },
                    set: { model.update(\.fontSize, key: "fontSize", value: $0) }
                )) {
                    Text("S").tag("small")
                    Text("M").tag("medium")
                    Text("L").tag("large")
                }
                .pickerStyle(.segmented)
                .frame(width: 180)
                SettingHint(text: "S, M, and L change the sidebar, settings, and file editor. The terminal has its own size under Terminal.")
            }
        }
    }
}

private struct TerminalSettings: View {
    @ObservedObject var model: NativeSettingsModel

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Terminal") {
                Toggle("Cursor blink", isOn: boolBinding(\.cursorBlink, "cursorBlink"))
                Picker("Scrollback", selection: intBinding(\.scrollback, "scrollback")) {
                    Text("1,000 lines").tag(1_000)
                    Text("5,000 lines").tag(5_000)
                    Text("10,000 lines").tag(10_000)
                    Text("50,000 lines").tag(50_000)
                }
                Picker("Terminal font size", selection: intBinding(\.terminalFontSize, "terminalFontSize")) {
                    ForEach([12, 13, 14, 15, 16], id: \.self) { size in
                        Text("\(size) pt").tag(size)
                    }
                }
                SettingHint(text: "Applies to this Mac app immediately, and to the browser terminal the next time it opens.")
            }

            SettingsSection(title: "Phone and browser") {
                Toggle("Custom mobile keyboard", isOn: boolBinding(\.customKeyboard, "customKeyboard"))
                SettingHint(text: "Only the phone and browser keyboards. This Mac app uses the system keyboard.")
            }

            SettingsSection(title: "Ghostty config") {
                SettingsCard {
                    Text("Ghostty also reads ~/.config/ghostty/config")
                        .font(.body.monospaced())
                    SettingHint(text: "Theme colors and extra key bindings stay in that file. Font size, blink, and scrollback above override it.")
                    Button("Open Ghostty config") {
                        let url = FileManager.default.homeDirectoryForCurrentUser
                            .appending(path: ".config/ghostty/config")
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
    }

    private func boolBinding(
        _ path: WritableKeyPath<NativePreferences, Bool>,
        _ key: String
    ) -> Binding<Bool> {
        Binding(
            get: { model.preferences[keyPath: path] },
            set: { model.update(path, key: key, value: $0) }
        )
    }

    private func intBinding(
        _ path: WritableKeyPath<NativePreferences, Int>,
        _ key: String
    ) -> Binding<Int> {
        Binding(
            get: { model.preferences[keyPath: path] },
            set: { model.update(path, key: key, value: $0) }
        )
    }
}

// MARK: - Health

private struct HealthSettings: View {
    @ObservedObject var model: NativeSettingsModel

    var body: some View {
        SettingsPage {
            SettingsSection(title: "Claude status hooks") {
                if let hooks = model.hooks {
                    SettingsCard {
                        HStack {
                            Image(systemName: hooks.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                                .foregroundStyle(hooks.ok ? .green : .orange)
                            Text(hooks.ok ? "All \(hooks.installed.count) hooks installed" : "\(hooks.missing.count) hooks missing")
                                .fontWeight(.semibold)
                            Spacer()
                            if !hooks.ok {
                                Button("Install") { Task { await model.installHooks() } }
                                    .buttonStyle(.borderedProminent)
                            }
                        }
                        SettingHint(text: "Without hooks, AgentDock has to infer state from terminal output. Installing writes to \(hooks.settingsPath).")
                        ForEach(hooks.events ?? []) { event in
                            HStack {
                                Circle()
                                    .fill(hooks.installed.contains(event.event) ? .green : .red)
                                    .frame(width: 7, height: 7)
                                Text(event.event).font(.caption.monospaced())
                                Text(event.status).font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                Text(event.means).font(.caption).foregroundStyle(.tertiary)
                            }
                        }
                    }
                } else {
                    ProgressView("Checking hooks…")
                }
            }

            SettingsSection(title: "External tools") {
                if let health = model.health {
                    tool("tmux", health.tmux, required: true)
                    tool("claude", health.claude, required: true)
                    tool("cursor (agent CLI)", health.cursor, required: false)
                    tool("git", health.git, required: true)
                    tool("gh (GitHub CLI)", health.gh, required: false)
                    tool("bun", health.bun, required: true)
                    tool("psql", health.psql, required: false)
                } else {
                    ProgressView("Checking tools…")
                }
                Button("Check again") { Task { await model.refreshHealth() } }
                    .disabled(model.busy)
            }

            SettingsSection(title: "Language servers") {
                SettingsCard {
                    SettingHint(text: "Cmd-click in Files asks these for definitions, references and signatures. A language it has no server for falls back to AgentDock's own symbol index, which cannot resolve overloads. Servers start on first use and stop after ten idle minutes.")
                }
                if model.languageServers.isEmpty {
                    ProgressView("Checking language servers…")
                } else {
                    ForEach(model.languageServers) { server in
                        languageServer(server)
                    }
                }
                Button("Check again") { Task { await model.refreshLanguageServers() } }
                    .disabled(model.busy)
            }
        }
    }

    private func languageServer(_ server: LanguageServerStatus) -> some View {
        let dot: Color = server.running ? .green : (server.installed ? .gray : .red)
        return SettingsCard {
            HStack {
                Circle()
                    .fill(dot)
                    .frame(width: 8, height: 8)
                Text(server.serverId).fontWeight(.semibold)
                Spacer()
                Text(server.running
                     ? (server.warm ? "running · warm" : "starting")
                     : (server.installed ? "installed · idle" : "not installed"))
                    .font(.caption)
                    .foregroundStyle(server.installed ? Color.secondary : Color.red)
            }
            Text(server.command)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
            if server.running, !server.root.isEmpty {
                Text("\(URL(fileURLWithPath: server.root).lastPathComponent) · \(server.openDocuments ?? 0) open")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let error = server.lastError, !server.running {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .lineLimit(2)
            }
        }
    }

    private func tool(_ name: String, _ health: ToolHealth, required: Bool) -> some View {
        SettingsCard {
            HStack {
                Circle()
                    .fill(health.installed ? .green : .red)
                    .frame(width: 8, height: 8)
                Text(name).fontWeight(.semibold)
                Spacer()
                if health.installed {
                    Text(health.version)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text(required ? "missing · required" : "missing · optional")
                        .font(.caption)
                        .foregroundStyle(required ? .red : .secondary)
                }
            }
        }
    }
}

// MARK: - Shortcuts

private struct ShortcutSettings: View {
    private let groups: [(String, [(String, String)])] = [
        ("Workspace", [
            ("⌘1 … ⌘4", "Open Terminal, Files, Plan, or Changes"),
            ("⇧⌘[ / ⇧⌘]", "Previous or next session"),
            ("⌘R", "Reload sessions"),
        ]),
        ("Editor", [
            ("⌘[ / ⌘]", "Back or forward through file locations"),
            ("⌃⌘J", "Jump to definition or usages"),
            ("⌘F", "Find in the current file"),
        ]),
        ("Standard macOS", [
            ("⌘,", "Open Settings"),
            ("⌘W", "Close the current window"),
            ("⌘Q", "Quit AgentDock"),
        ]),
    ]

    var body: some View {
        SettingsPage {
            ForEach(groups, id: \.0) { group in
                SettingsSection(title: group.0) {
                    SettingsCard {
                        ForEach(group.1, id: \.0) { shortcut in
                            HStack {
                                Text(shortcut.0)
                                    .font(.caption.monospaced().bold())
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 4)
                                    .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 5))
                                    .frame(width: 130, alignment: .leading)
                                Text(shortcut.1)
                                Spacer()
                            }
                        }
                    }
                }
            }
        }
    }
}
