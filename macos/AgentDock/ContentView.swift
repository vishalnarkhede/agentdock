import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.agentDockTheme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            NativeQueueAttentionBar()
            NavigationSplitView {
                SessionSidebarView()
                    .environmentObject(model.settings)
                    .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 360)
            } detail: {
                if let session = model.selectedSession {
                    SessionWorkspace(session: session)
                        .id(session.id)
                } else {
                    NativeQuietView()
                }
            }
        }
        .background(theme.background)
        .toolbarBackground(theme.chrome, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
        .alert(
            "AgentDock",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )
        ) {
            Button("Retry") {
                Task { await model.start() }
            }
            Button("Dismiss", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
        .sheet(isPresented: $model.needsAuthentication) {
            LoginView()
                .environmentObject(model)
                .interactiveDismissDisabled()
        }
    }
}

private struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @State private var password = ""
    @State private var submitting = false

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "terminal")
                .font(.system(size: 42))
                .foregroundStyle(.tint)
            Text("Connect to AgentDock")
                .font(.title2.bold())
            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .onSubmit(submit)
            Button(action: submit) {
                if submitting {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Text("Sign In")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(password.isEmpty || submitting)
        }
        .padding(32)
        .frame(width: 360)
    }

    private func submit() {
        guard !password.isEmpty, !submitting else { return }
        submitting = true
        Task {
            _ = await model.login(password: password)
            submitting = false
        }
    }
}

private struct SessionWorkspace: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.agentDockTheme) private var theme
    @State private var droppingFiles = false
    let session: AgentSession

    private var tab: Binding<WorkspaceTab> {
        Binding(
            get: { model.tab(for: session.id) },
            set: { model.select(tab: $0, for: session.id) }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Picker("View", selection: tab) {
                    ForEach(WorkspaceTab.allCases) { tab in
                        Label(tab.title, systemImage: tab.systemImage)
                            .tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 520)
                Spacer()
                Text(session.agentType?.capitalized ?? "Agent")
                    .foregroundStyle(.secondary)
            }
            .padding(10)
            .background(theme.chrome)

            Divider()

            Group {
                switch tab.wrappedValue {
                case .terminal:
                    GhosttyTerminalView(session: session)
                case .files:
                    NativeFileExplorerView(model: model.files.model(for: session))
                case .plan:
                    NativePlanView(model: model.plans.model(for: session))
                case .changes:
                    NativeChangesView(model: model.changes.model(for: session))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.background)
        }
        .background(theme.background)
        .onDrop(of: [.fileURL], isTargeted: $droppingFiles) { providers in
            // The terminal view owns Finder drops so we do not type the path twice.
            guard tab.wrappedValue != .terminal else { return false }
            Task {
                let urls = await SessionFileDrop.urls(from: providers)
                model.sendDroppedFiles(urls, to: session)
            }
            return true
        }
        .overlay {
            if droppingFiles, tab.wrappedValue != .terminal {
                ZStack {
                    theme.background.opacity(0.55)
                    Text("Drop files here")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(theme.textBright)
                }
                .allowsHitTesting(false)
            }
        }
        .navigationTitle(session.displayName)
    }
}

