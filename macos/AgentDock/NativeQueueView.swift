import SwiftUI

struct NativeQueueAttentionBar: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.agentDockTheme) private var theme

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: model.queueCounts.blocked > 0
                ? "exclamationmark.bubble.fill"
                : "checkmark.circle.fill")
                .foregroundStyle(model.queueCounts.blocked > 0 ? theme.amber : theme.green)

            Text(model.queueCounts.summary)
                .font(.callout.weight(.medium))
                .lineLimit(1)

            if !model.blockedSessions.isEmpty {
                Divider().frame(height: 18)
                ForEach(model.blockedSessions.prefix(3)) { session in
                    Button {
                        model.selectSession(session.name)
                    } label: {
                        HStack(spacing: 5) {
                            SessionStatusIndicator(kind: .of(session))
                            Text(session.displayName).lineLimit(1)
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                if model.blockedSessions.count > 3 {
                    Text("+\(model.blockedSessions.count - 3)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            Button {
                model.selectNextQueueItem()
            } label: {
                Label("Next", systemImage: "arrow.right")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(model.sessions.isEmpty)
            .help("Jump to the highest-cost item in the queue")
        }
        .padding(.horizontal, 12)
        .frame(height: 42)
        .background(theme.chrome)
        .overlay(alignment: .bottom) { Divider() }
    }
}

struct NativeQuietView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.agentDockTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                Image(systemName: "checkmark.circle")
                    .font(.system(size: 52, weight: .light))
                    .foregroundStyle(theme.green)
                VStack(spacing: 7) {
                    Text("Nothing is waiting on you")
                        .font(.largeTitle.bold())
                    Text(model.staleSessions.isEmpty
                        ? "The queue is clear. Start something, or open an idle session from the sidebar."
                        : "\(model.staleSessions.count) stopped session\(model.staleSessions.count == 1 ? "" : "s") can still be restored.")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                HStack(spacing: 12) {
                    Button {
                        model.showingCreateSession = true
                    } label: {
                        Label("New session", systemImage: "plus")
                    }
                    .buttonStyle(.borderedProminent)

                    Button {
                        model.selectNextQueueItem()
                    } label: {
                        Label("Open next session", systemImage: "arrow.right")
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.sessions.isEmpty)
                }

                if !model.staleSessions.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        HStack {
                            Text("RESTORABLE SESSIONS")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Restore all") {
                                for session in model.staleSessions {
                                    Task { await model.restoreSession(session) }
                                }
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(12)
                        Divider()
                        ForEach(model.staleSessions) { session in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(session.displayName).fontWeight(.medium)
                                    Text(session.path)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Button("Restore") {
                                    Task { await model.restoreSession(session) }
                                }
                            }
                            .padding(12)
                            if session.id != model.staleSessions.last?.id { Divider() }
                        }
                    }
                    .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12).stroke(.separator.opacity(0.5))
                    }
                    .frame(maxWidth: 680)
                }
            }
            .padding(40)
            .frame(maxWidth: .infinity, minHeight: 520)
        }
    }
}
