import SwiftUI

@main
struct AgentDockApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            NativeAppRoot(settings: model.settings)
                .environmentObject(model)
                .task {
                    await model.start()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 900)
        .commands {
            CommandMenu("Session") {
                ForEach(Array(WorkspaceTab.allCases.enumerated()), id: \.element) { index, tab in
                    Button(tab.title) {
                        model.selectTabForCurrentSession(tab)
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }

                Divider()

                Button("Next Session") {
                    model.selectAdjacentSession(offset: 1)
                }
                .keyboardShortcut("]", modifiers: [.command, .shift])

                Button("Previous Session") {
                    model.selectAdjacentSession(offset: -1)
                }
                .keyboardShortcut("[", modifiers: [.command, .shift])

                Divider()

                Button("Reload Sessions") {
                    Task { await model.refresh() }
                }
                .keyboardShortcut("r", modifiers: .command)
            }

            CommandMenu("Navigate") {
                Button("Back") {
                    model.navigateEditorBack()
                }
                .keyboardShortcut("[", modifiers: .command)

                Button("Forward") {
                    model.navigateEditorForward()
                }
                .keyboardShortcut("]", modifiers: .command)

                Button("Jump to Definition") {
                    model.jumpToEditorDefinition()
                }
                .keyboardShortcut("j", modifiers: [.command, .control])
            }
        }

        Settings {
            NativeSettingsRoot(settings: model.settings)
                .environmentObject(model)
                .frame(minWidth: 820, idealWidth: 940, minHeight: 580, idealHeight: 680)
        }
    }
}

private struct NativeAppRoot: View {
    @ObservedObject var settings: NativeSettingsModel

    var body: some View {
        ContentView()
            .agentDockThemed(settings.theme, chrome: settings.chrome)
            .dynamicTypeSize(settings.dynamicTypeSize)
    }
}

private struct NativeSettingsRoot: View {
    @ObservedObject var settings: NativeSettingsModel

    var body: some View {
        NativeSettingsView()
            .agentDockThemed(settings.theme, chrome: settings.chrome)
            .dynamicTypeSize(settings.dynamicTypeSize)
    }
}
