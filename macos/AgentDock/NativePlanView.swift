import CodeEditSourceEditor
import SwiftUI

@MainActor
final class PlanStateStore {
    private var models: [String: NativePlanModel] = [:]

    func model(for session: AgentSession) -> NativePlanModel {
        if let model = models[session.id] { return model }
        let model = NativePlanModel(session: session)
        models[session.id] = model
        return model
    }

    func remove(sessionID: String) {
        models.removeValue(forKey: sessionID)
    }
}

@MainActor
final class NativePlanModel: ObservableObject {
    @Published var plan: String?
    @Published var comments: [PlanComment] = []
    @Published var loading = true
    @Published var rawMode = false
    @Published var composingBlockID: String?
    @Published var sending = false
    @Published var error: String?
    @Published var scrollTarget: String?
    @Published private(set) var blocks: [PlanBlock] = []
    @Published private(set) var groups: [PlanGroup] = []
    @Published private(set) var outline: [PlanOutlineItem] = []
    @Published private(set) var planVersion = 0

    let session: AgentSession
    private let api = APIClient()
    private var hash = ""

    init(session: AgentSession) {
        self.session = session
    }

    var progress: (done: Int, total: Int) {
        blocks.reduce(into: (0, 0)) { result, block in
            guard let checked = block.checked else { return }
            result.1 += 1
            if checked { result.0 += 1 }
        }
    }

    var unsentComments: [PlanComment] {
        comments.filter { $0.sentAt == nil && $0.resolvedAt == nil }
    }

    func comments(for group: PlanGroup) -> [PlanComment] {
        let ids = group.ids
        let matching = comments.filter { ids.contains($0.blockId) }
        return matching.sorted { lhs, rhs in
            if (lhs.resolvedAt == nil) != (rhs.resolvedAt == nil) { return lhs.resolvedAt == nil }
            return lhs.createdAt < rhs.createdAt
        }
    }

    func load() async {
        do {
            let payload = try await api.fetchPlan(session.name, since: hash.isEmpty ? nil : hash)
            // An unchanged plan must not touch published state: re-parsing it
            // every four seconds throws away the open composer and the scroll.
            if !payload.unchanged {
                plan = payload.plan
                hash = payload.hash
                rebuild()
            }
            let fetched = try await api.fetchPlanComments(session.name)
            if fetched != comments { comments = fetched }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func rebuild() {
        blocks = plan.map(PlanParser.blocks(from:)) ?? []
        groups = PlanGroup.group(blocks)
        outline = PlanOutlineItem.outline(of: blocks)
        planVersion += 1
        if let composing = composingBlockID, !blocks.contains(where: { $0.id == composing }) {
            composingBlockID = nil
        }
    }

    func addComment(to block: PlanBlock, body: String) async {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        do {
            let comment = try await api.createPlanComment(
                sessionName: session.name,
                blockID: block.id,
                anchorText: block.text,
                body: text
            )
            comments.append(comment)
            composingBlockID = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func toggleResolved(_ comment: PlanComment) async {
        do {
            let updated = try await api.patchPlanComment(
                sessionName: session.name,
                id: comment.id,
                values: ["resolved": comment.resolvedAt == nil]
            )
            replace(updated)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func delete(_ comment: PlanComment) async {
        do {
            try await api.deletePlanComment(sessionName: session.name, id: comment.id)
            comments.removeAll { $0.id == comment.id }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func sendCommentsToAgent() async {
        let pending = unsentComments
        guard !pending.isEmpty else { return }
        sending = true
        defer { sending = false }
        let text = pending.map {
            "Regarding this part of the plan:\n```\n\($0.anchorText)\n```\n\($0.body)"
        }.joined(separator: "\n\n")
        do {
            try await api.sendInput(
                "Please address these plan comments:\n\n\(text)",
                to: session.name
            )
            for comment in pending {
                let updated = try await api.patchPlanComment(
                    sessionName: session.name,
                    id: comment.id,
                    values: ["sent": true]
                )
                replace(updated)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func replace(_ comment: PlanComment) {
        guard let index = comments.firstIndex(where: { $0.id == comment.id }) else { return }
        comments[index] = comment
    }

}

struct NativePlanView: View {
    @Environment(\.agentDockTheme) private var theme
    @ObservedObject var model: NativePlanModel
    @State private var rawEditorState = SourceEditorState()

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if !model.unsentComments.isEmpty {
                Divider()
                unsentBar
            }
        }
        .task {
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(for: .seconds(4))
            }
        }
        .alert(
            "Plan",
            isPresented: Binding(
                get: { model.error != nil },
                set: { if !$0 { model.error = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.error ?? "")
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            let progress = model.progress
            if progress.total > 0 {
                ProgressRing(fraction: Double(progress.done) / Double(progress.total))
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(progress.done) of \(progress.total) steps")
                        .font(.callout.bold())
                    Text(progress.done == progress.total ? "Checklist complete" : "\(progress.total - progress.done) remaining")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } else if !model.blocks.isEmpty {
                Text("\(model.blocks.count) blocks")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            if !model.outline.isEmpty {
                Text("\(model.outline.count) section\(model.outline.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary.opacity(0.5), in: Capsule())
            }

            Spacer()

            let unsent = model.unsentComments.count
            if unsent > 0 {
                Label("\(unsent) unsent", systemImage: "text.bubble")
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
            }

            Picker("", selection: $model.rawMode) {
                Text("Rendered").tag(false)
                Text("Raw").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 170)

            Button {
                Task { await model.load() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh the plan")
        }
        .padding(10)
        .background(theme.chrome)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if model.loading, model.plan == nil {
            ProgressView("Loading plan…")
        } else if let plan = model.plan, !plan.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if model.rawMode {
                NativeCodeEditor(
                    text: .constant(plan),
                    path: "\(model.session.name)-plan.md",
                    editable: false,
                    state: $rawEditorState,
                    jumpBridge: nil,
                    editorBridge: nil,
                    epoch: model.planVersion
                )
            } else if model.outline.count > 1 {
                HSplitView {
                    outlineSidebar
                        .frame(minWidth: 180, idealWidth: 230, maxWidth: 340)
                    document
                        .frame(minWidth: 420)
                }
            } else {
                document
            }
        } else {
            ContentUnavailableView(
                "No plan yet",
                systemImage: "list.bullet.clipboard",
                description: Text("Ask the agent to write a plan for this session.")
            )
        }
    }

    private var outlineSidebar: some View {
        List(model.outline) { item in
            Button {
                model.scrollTarget = item.id
            } label: {
                HStack(spacing: 6) {
                    Color.clear.frame(width: CGFloat(max(0, item.level - 1) * 10), height: 1)
                    Text(item.title)
                        .font(item.level == 1 ? .callout.bold() : .callout)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    if let label = item.progressLabel {
                        Text(label)
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(item.done == item.total ? .green : .secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .listStyle(.sidebar)
    }

    private var document: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(model.groups) { group in
                        PlanGroupRow(
                            group: group,
                            comments: model.comments(for: group),
                            composing: model.composingBlockID == group.id,
                            onStartComment: { model.composingBlockID = group.id },
                            onCancelComment: { model.composingBlockID = nil },
                            onSubmitComment: { body in
                                Task { await model.addComment(to: group.anchor, body: body) }
                            },
                            onResolve: { comment in Task { await model.toggleResolved(comment) } },
                            onDelete: { comment in Task { await model.delete(comment) } }
                        )
                        .id(group.id)
                    }
                }
                .frame(maxWidth: 860, alignment: .leading)
                .padding(.vertical, 20)
                .padding(.horizontal, 28)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .onChange(of: model.scrollTarget) { _, target in
                guard let target else { return }
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(target, anchor: .top)
                }
                model.scrollTarget = nil
            }
        }
    }

    private var unsentBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "text.bubble")
            Text("\(model.unsentComments.count) unsent comment\(model.unsentComments.count == 1 ? "" : "s")")
                .font(.callout.bold())
            Text("The agent has not seen these yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                Task { await model.sendCommentsToAgent() }
            } label: {
                if model.sending {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Send to agent", systemImage: "paperplane.fill")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.sending)
        }
        .padding(10)
        .background(theme.chrome)
    }
}

private struct ProgressRing: View {
    let fraction: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(.quaternary, lineWidth: 3)
            Circle()
                .trim(from: 0, to: max(0.001, min(1, fraction)))
                .stroke(
                    fraction >= 1 ? Color.green : Color.accentColor,
                    style: StrokeStyle(lineWidth: 3, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 22, height: 22)
        .animation(.easeOut(duration: 0.25), value: fraction)
    }
}

private struct PlanGroupRow: View {
    let group: PlanGroup
    let comments: [PlanComment]
    let composing: Bool
    let onStartComment: () -> Void
    let onCancelComment: () -> Void
    let onSubmitComment: (String) -> Void
    let onResolve: (PlanComment) -> Void
    let onDelete: (PlanComment) -> Void

    @State private var hovering = false

    private var openComments: [PlanComment] { comments.filter { $0.resolvedAt == nil } }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            gutter
            VStack(alignment: .leading, spacing: 8) {
                content
                if !comments.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(comments) { comment in
                            PlanCommentCard(
                                comment: comment,
                                onResolve: { onResolve(comment) },
                                onDelete: { onDelete(comment) }
                            )
                        }
                    }
                }
                if composing {
                    PlanCommentComposer(
                        anchor: group.anchor.text,
                        onCancel: onCancelComment,
                        onSubmit: onSubmitComment
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, group.kind == .heading ? 6 : 1)
        .onHover { hovering = $0 }
    }

    private var gutter: some View {
        Button(action: onStartComment) {
            HStack(spacing: 2) {
                Image(systemName: openComments.isEmpty ? "plus.bubble" : "bubble.left.fill")
                    .font(.caption)
                if !openComments.isEmpty {
                    Text("\(openComments.count)")
                        .font(.caption2.bold())
                }
            }
            .foregroundStyle(openComments.isEmpty ? .secondary : Color.accentColor)
            .opacity(openComments.isEmpty && !hovering && !composing ? 0.25 : 1)
            .frame(width: 26, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .help("Comment on this")
        .padding(.top, group.kind == .heading ? 4 : 2)
    }

    @ViewBuilder
    private var content: some View {
        switch group.kind {
        case .heading:
            VStack(alignment: .leading, spacing: 6) {
                if group.level <= 2 {
                    Divider()
                }
                Text(PlanText.headingTitle(group.anchor.text))
                    .font(headingFont)
            }
        case .list:
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Color.clear.frame(width: CGFloat(group.level * 16), height: 1)
                if let checked = group.anchor.checked {
                    Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 13))
                        .foregroundStyle(checked ? .green : .secondary)
                } else {
                    Circle()
                        .fill(.secondary)
                        .frame(width: 4, height: 4)
                        .padding(.horizontal, 4)
                }
                Text(PlanText.inline(PlanParser.normalizedListText(group.anchor.text)))
                    .strikethrough(group.anchor.checked == true, color: .secondary)
                    .foregroundStyle(group.anchor.checked == true ? .secondary : .primary)
                    .textSelection(.enabled)
            }
        case .code:
            PlanCodeCard(code: group.blocks.map(\.text).joined(separator: "\n"))
        case .quote:
            HStack(alignment: .top, spacing: 9) {
                Rectangle()
                    .fill(Color.accentColor.opacity(0.55))
                    .frame(width: 3)
                Text(
                    group.blocks
                        .map { $0.text.dropFirst().trimmingCharacters(in: .whitespaces) }
                        .joined(separator: "\n")
                )
                .italic()
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            }
            .padding(.vertical, 2)
        case .rule:
            Divider().padding(.vertical, 4)
        case .table:
            PlanTableView(table: PlanTable(lines: group.blocks.map(\.text)))
        case .paragraph:
            Text(PlanText.inline(group.anchor.text))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var headingFont: Font {
        switch group.level {
        case 1: .title2.bold()
        case 2: .title3.bold()
        case 3: .headline
        default: .subheadline.bold()
        }
    }
}

private struct PlanCodeCard: View {
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("code")
                    .font(.caption2.bold())
                    .foregroundStyle(.tertiary)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption2)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)

            Text(code)
                .font(.system(size: 12, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
        }
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(.quaternary.opacity(0.6)))
    }
}

private struct PlanTableView: View {
    let table: PlanTable

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Grid(alignment: .topLeading, horizontalSpacing: 16, verticalSpacing: 6) {
                if !table.header.isEmpty {
                    GridRow {
                        ForEach(Array(table.header.enumerated()), id: \.offset) { _, cell in
                            Text(PlanText.inline(cell))
                                .font(.caption.bold())
                        }
                    }
                    // A bare view inside Grid spans every column.
                    Divider()
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(PlanText.inline(cell))
                                .font(.caption)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(.quaternary.opacity(0.22), in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(.quaternary.opacity(0.6)))
        .textSelection(.enabled)
    }
}

private struct PlanCommentCard: View {
    let comment: PlanComment
    let onResolve: () -> Void
    let onDelete: () -> Void

    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                if comment.orphaned == true {
                    Chip(text: "outdated", color: .orange)
                        .help("The plan text this was written against has been rewritten")
                }
                if comment.sentAt != nil {
                    Chip(text: "sent", color: .green)
                }
                if comment.resolvedAt != nil {
                    Chip(text: "resolved", color: .secondary)
                }
                Text(Self.relative.localizedString(
                    for: Date(timeIntervalSince1970: comment.createdAt / 1000),
                    relativeTo: .now
                ))
                .font(.caption2)
                .foregroundStyle(.tertiary)

                Spacer()

                Button(comment.resolvedAt == nil ? "Resolve" : "Reopen", action: onResolve)
                    .font(.caption)
                Button("Delete", action: onDelete)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            .buttonStyle(.borderless)

            Text(comment.body)
                .font(.callout)
                .foregroundStyle(comment.resolvedAt == nil ? .primary : .secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(9)
        .background(
            comment.resolvedAt == nil
                ? Color.accentColor.opacity(0.08)
                : Color.secondary.opacity(0.08),
            in: RoundedRectangle(cornerRadius: 7)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7)
                .stroke(comment.resolvedAt == nil ? Color.accentColor.opacity(0.28) : .clear)
        )
    }
}

private struct Chip: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2.bold())
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color.opacity(0.16), in: RoundedRectangle(cornerRadius: 4))
    }
}

private struct PlanCommentComposer: View {
    let anchor: String
    let onCancel: () -> Void
    let onSubmit: (String) -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(anchor)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(2)
            TextField("Comment on this step…", text: $draft, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
            HStack {
                Text("⌘↵ to save")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Comment") { submit() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 7))
        .onAppear { focused = true }
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        onSubmit(text)
        draft = ""
    }
}
