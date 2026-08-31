import SwiftUI

struct SessionSidebarView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: NativeSettingsModel
    @Environment(\.agentDockTheme) private var theme
    @State private var search = ""
    @State private var editingSession: AgentSession?
    @State private var renameDraft = ""
    @State private var deletingSession: AgentSession?

    private let queueOrder = ["Waiting on you", "Ready to review", "Working", "Idle", "Stale"]

    var body: some View {
        List(selection: Binding(
            get: { model.selectedSessionID },
            set: { if let name = $0 { model.selectSession(name) } }
        )) {
            if !pinned.isEmpty {
                sessionSection("Pinned", sessions: pinned, collapsible: true)
            }

            ForEach(grouped, id: \.name) { group in
                sessionSection(group.name, sessions: group.sessions, collapsible: grouped.count > 1)
            }
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .searchable(text: $search, placement: .sidebar, prompt: "Find session")
        .navigationTitle("AgentDock")
        .toolbar {
            ToolbarItemGroup {
                Button {
                    model.showingCreateSession = true
                } label: {
                    Label("New Session", systemImage: "plus")
                }

                Menu {
                    Picker("Group", selection: Binding(
                        get: { model.groupBy },
                        set: model.setGrouping
                    )) {
                        Text("Queue").tag("__queue__")
                        Text("Status").tag("__status__")
                        Text("Agent").tag("agent")
                        Text("Repository").tag("repo")
                        Text("None").tag("")
                        if !settings.metaProperties.isEmpty {
                            Divider()
                            ForEach(settings.metaProperties) { preset in
                                Text(preset.label).tag(preset.key)
                            }
                        }
                    }

                    Divider()

                    Picker("Sort", selection: Binding(
                        get: { model.sortBy },
                        set: model.setSorting
                    )) {
                        Text("Saved order").tag("")
                        Text("Name").tag("name")
                        Text("Newest").tag("newest")
                        Text("Oldest").tag("oldest")
                    }
                } label: {
                    Label("Organize", systemImage: "line.3.horizontal.decrease.circle")
                }

                Button {
                    Task { await model.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .sheet(item: $editingSession) { session in
            renameSheet(session)
        }
        .sheet(isPresented: $model.showingCreateSession) {
            CreateSessionView()
                .environmentObject(model)
        }
        .confirmationDialog(
            "Kill \(deletingSession?.displayName ?? "session")?",
            isPresented: Binding(
                get: { deletingSession != nil },
                set: { if !$0 { deletingSession = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Kill session", role: .destructive) {
                guard let session = deletingSession else { return }
                Task { await model.deleteSession(session) }
                deletingSession = nil
            }
        } message: {
            Text("The tmux session will stop. Isolated worktrees are handled by the server.")
        }
    }

    @ViewBuilder
    private func sessionSection(
        _ title: String,
        sessions: [AgentSession],
        collapsible: Bool
    ) -> some View {
        let collapsed = model.collapsedGroups.contains(title)
        Section {
            if !collapsed {
                ForEach(sessions) { session in
                    SessionSidebarRow(
                        session: session,
                        pinned: model.pinnedSessions.contains(session.name),
                        selected: model.selectedSessionID == session.name,
                        showSeparator: session.id != sessions.last?.id
                    )
                    .padding(.leading, session.parentSession == nil ? 0 : 14)
                    .tag(session.name)
                    .listRowInsets(EdgeInsets(top: 3, leading: 10, bottom: 3, trailing: 10))
                    .listRowBackground(rowBackground(selected: model.selectedSessionID == session.name))
                    .listRowSeparator(.hidden)
                    .contextMenu {
                        sessionMenu(session)
                    }
                }
            }
        } header: {
            Button {
                if collapsible { model.toggleGroup(title) }
            } label: {
                HStack {
                    if collapsible {
                        Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                            .font(.caption2)
                    }
                    groupStatusIcon(title)
                    Text(title)
                        .foregroundStyle(theme.textDim)
                    Spacer()
                    Text("\(sessions.count)")
                        .foregroundStyle(theme.textDim)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func rowBackground(selected: Bool) -> some View {
        ZStack {
            theme.background
            if selected {
                theme.hover
                theme.accent.opacity(0.16)
            }
        }
    }

    @ViewBuilder
    private func groupStatusIcon(_ title: String) -> some View {
        switch title {
        case "Working":
            SessionWorkingSpinner(color: theme.cyan)
                .frame(width: 10, height: 10)
        case "Ready to review":
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(theme.green)
        case "Waiting on you":
            Image(systemName: "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundStyle(theme.amber)
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private func sessionMenu(_ session: AgentSession) -> some View {
        Button(model.pinnedSessions.contains(session.name) ? "Unpin" : "Pin") {
            model.togglePin(session.name)
        }

        if session.status == .stopped {
            Button("Restore") {
                Task { await model.restoreSession(session) }
            }
        } else {
            Button("Open in iTerm") {
                Task { await model.openInITerm(session) }
            }
            Button("Switch to \(session.agentType == "cursor" ? "Claude" : "Cursor")") {
                Task { await model.switchAgent(session) }
            }
        }

        Button("Rename…") {
            renameDraft = session.displayName
            editingSession = session
        }

        Divider()

        Button("Kill", role: .destructive) {
            deletingSession = session
        }
    }

    private func renameSheet(_ session: AgentSession) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Rename session")
                .font(.title2.bold())
            TextField("Name", text: $renameDraft)
                .textFieldStyle(.roundedBorder)
                .onSubmit { submitRename(session) }
            HStack {
                Spacer()
                Button("Cancel") { editingSession = nil }
                Button("Rename") { submitRename(session) }
                    .buttonStyle(.borderedProminent)
                    .disabled(renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 380)
    }

    private func submitRename(_ session: AgentSession) {
        let value = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        editingSession = nil
        Task { await model.renameSession(session, to: value) }
    }

    private var visibleSessions: [AgentSession] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let all = model.sessions
        let filtered = query.isEmpty ? all : all.filter {
            $0.displayName.lowercased().contains(query)
                || $0.path.lowercased().contains(query)
                || ($0.statusLine?.message.lowercased().contains(query) ?? false)
                || ($0.meta?.values.contains(where: { $0.lowercased().contains(query) }) ?? false)
        }

        switch model.sortBy {
        case "name":
            return filtered.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        case "newest":
            return filtered.sorted { $0.created > $1.created }
        case "oldest":
            return filtered.sorted { $0.created < $1.created }
        default:
            return filtered
        }
    }

    private var pinned: [AgentSession] {
        visibleSessions.filter { model.pinnedSessions.contains($0.name) }
    }

    private var grouped: [(name: String, sessions: [AgentSession])] {
        let unpinned = visibleSessions.filter { !model.pinnedSessions.contains($0.name) }
        guard !model.groupBy.isEmpty else {
            return unpinned.isEmpty ? [] : [("Sessions", unpinned)]
        }

        let pairs = Dictionary(grouping: unpinned) { session -> String in
            switch model.groupBy {
            case "__queue__": return queueLabel(session)
            case "__status__": return statusLabel(session)
            case "agent": return session.agentType?.capitalized ?? "Other"
            case "repo":
                return session.worktrees.first?.repoPath
                    .split(separator: "/").last.map(String.init) ?? "Other"
            default:
                let value = session.meta?[model.groupBy]?.trimmingCharacters(in: .whitespacesAndNewlines)
                return (value?.isEmpty == false) ? value! : "No value"
            }
        }

        let order = groupOrder(for: pairs)
        return order.compactMap { name in
            guard let sessions = pairs[name], !sessions.isEmpty else { return nil }
            return (name, sessions)
        }
    }

    private func queueLabel(_ session: AgentSession) -> String {
        if session.status == .stopped { return "Stale" }
        if session.statusLine?.type == "input" || session.statusLine?.type == "error" {
            return "Waiting on you"
        }
        if session.status == .working || session.status == .background { return "Working" }
        if session.statusLine?.type == "done" || session.status == .waiting {
            return "Ready to review"
        }
        return "Idle"
    }

    private func statusLabel(_ session: AgentSession) -> String {
        if session.status == .stopped { return "Stopped" }
        if let type = session.statusLine?.type, !type.isEmpty {
            return type.capitalized
        }
        switch session.status {
        case .shell: return "Done"
        case .unknown: return "Unknown"
        default: return session.status.rawValue.capitalized
        }
    }

    private func groupOrder(for pairs: [String: [AgentSession]]) -> [String] {
        switch model.groupBy {
        case "__queue__":
            return queueOrder
        case "__status__":
            let preferred = ["Working", "Background", "Input", "Error", "Waiting", "Done", "Unknown", "Stopped"]
            return preferred.filter { pairs[$0] != nil } + pairs.keys.sorted().filter { !preferred.contains($0) }
        default:
            let presetValues = settings.metaProperties.first { $0.key == model.groupBy }?.values ?? []
            var order = presetValues.filter { pairs[$0] != nil }
            for name in pairs.keys.sorted() where name != "No value" && !order.contains(name) {
                order.append(name)
            }
            if pairs["No value"] != nil { order.append("No value") }
            return order
        }
    }
}

private struct SessionSidebarRow: View {
    @Environment(\.agentDockTheme) private var theme
    @Environment(\.agentDockChrome) private var chrome
    let session: AgentSession
    let pinned: Bool
    let selected: Bool
    var showSeparator = true

    var body: some View {
        HStack(spacing: 9) {
                SessionStatusIndicator(kind: kind)

                VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(session.displayName)
                        .font(.system(size: chrome.body, weight: selected ? .semibold : .medium))
                        .foregroundStyle(selected ? theme.textBright : theme.textBright.opacity(0.92))
                        .lineLimit(1)
                    if pinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(theme.textDim)
                    }
                    Spacer()
                    if kind.isAttention {
                        Text(kind.badge)
                            .font(.caption2.weight(.semibold))
                            .textCase(.uppercase)
                            .tracking(0.5)
                            .foregroundStyle(kind.color(theme))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .overlay(
                                RoundedRectangle(cornerRadius: 3)
                                    .stroke(kind.color(theme).opacity(0.4), lineWidth: 1)
                            )
                    } else if let agent = session.agentType?.prefix(1).uppercased(), !agent.isEmpty {
                        Text(agent)
                            .font(.caption2.monospaced().bold())
                            .foregroundStyle(theme.textDim)
                    }
                }

                Text(detail)
                    .font(.system(size: chrome.caption))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)

                if let meta = session.meta, !meta.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(meta.sorted(by: { $0.key < $1.key }).prefix(2), id: \.key) { key, value in
                            Text("\(key): \(value)")
                                .font(.caption2)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .foregroundStyle(theme.textDim)
                                .background(theme.input, in: Capsule())
                        }
                    }
                }
            }
        }
        .padding(.vertical, 3)
        .opacity(session.status == .stopped ? 0.62 : 1)
        .overlay(alignment: .bottom) {
            if showSeparator {
                Rectangle()
                    .fill(theme.border.opacity(0.7))
                    .frame(height: 1)
                    .padding(.leading, 23)
            }
        }
    }

    private var detail: String {
        if session.status == .stopped { return "Stopped — restore available" }
        if let message = session.statusLine?.message, !message.isEmpty { return message }
        return session.path.replacingOccurrences(
            of: FileManager.default.homeDirectoryForCurrentUser.path,
            with: "~"
        )
    }

    private var kind: SessionDisplayKind { .of(session) }
}

struct SessionStatusIndicator: View {
    @Environment(\.agentDockTheme) private var theme
    let kind: SessionDisplayKind

    var body: some View {
        Group {
            switch kind {
            case .working:
                SessionWorkingSpinner(color: theme.cyan)
            case .review, .done:
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.green)
                    .symbolRenderingMode(.monochrome)
            case .blocked:
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.amber)
                    .symbolRenderingMode(.monochrome)
            case .error:
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.red)
                    .symbolRenderingMode(.monochrome)
            case .stale:
                Image(systemName: "minus.circle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.textDim)
            case .idle, .unknown:
                Circle()
                    .fill(theme.textDim.opacity(0.55))
            }
        }
        .frame(width: 14, height: 14)
        .accessibilityLabel(kind.badge)
    }
}

struct SessionWorkingSpinner: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let color: Color
    @State private var rotating = false

    var body: some View {
        Circle()
            .trim(from: 0.12, to: 0.88)
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            .rotationEffect(.degrees(rotating ? 360 : 0))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 0.7).repeatForever(autoreverses: false)) {
                    rotating = true
                }
            }
    }
}

extension SessionDisplayKind {
    func color(_ theme: AgentDockTheme) -> Color {
        switch self {
        case .working: theme.cyan
        case .review, .done: theme.green
        case .blocked: theme.amber
        case .error: theme.red
        case .idle, .stale, .unknown: theme.textDim
        }
    }
}
