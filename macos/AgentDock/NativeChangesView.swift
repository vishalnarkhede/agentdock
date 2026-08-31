import AppKit
import SwiftUI

@MainActor
final class ChangesStateStore {
    private var models: [String: NativeChangesModel] = [:]

    func model(for session: AgentSession) -> NativeChangesModel {
        if let model = models[session.id] { return model }
        let model = NativeChangesModel(session: session)
        models[session.id] = model
        return model
    }

    func remove(sessionID: String) {
        models.removeValue(forKey: sessionID)
    }
}

enum DiffMode: String, CaseIterable, Identifiable {
    case local
    case pullRequest

    var id: String { rawValue }
    var title: String { self == .local ? "Working tree" : "Pull request" }
}

/// A review note the user wrote against a range of diff lines, waiting to be
/// sent to the agent as one message.
struct DiffComment: Identifiable, Hashable {
    let id = UUID()
    let path: String
    let snippet: String
    let body: String
    let line: Int?
}

struct DiffSelection: Hashable {
    let path: String
    var anchor: Int
    var focus: Int

    var lower: Int { min(anchor, focus) }
    var upper: Int { max(anchor, focus) }

    func contains(_ lineID: Int) -> Bool { (lower...upper).contains(lineID) }
}

@MainActor
final class NativeChangesModel: ObservableObject {
    @Published var selectedRoot: String
    @Published private(set) var branch = ""
    @Published private(set) var prURL: String?
    @Published private(set) var files: [DiffFileChange] = []
    @Published private(set) var prFiles: [DiffFileChange] = []
    @Published private(set) var statusEntries: [GitStatusEntry] = []
    @Published private(set) var hasLoaded = false
    @Published var mode: DiffMode = .local
    @Published var loading = false
    @Published var loadingPRDiff = false
    @Published var prDiffError: String?
    @Published var busy = false
    @Published var error: String?
    @Published var notice: String?
    @Published var collapsedFiles: Set<String> = []
    @Published var revealedLargeFiles: Set<String> = []
    @Published var selection: DiffSelection?
    @Published var pendingComments: [DiffComment] = []
    @Published var scrollTarget: String?

    let session: AgentSession
    private let api = APIClient()
    private var fileSignature = ""

    /// Files with more lines than this open collapsed; SwiftUI lays out every
    /// row in an expanded card, and a 20k-line vendored diff stalls the pane.
    private static let largeFileLineCount = 1200

    init(session: AgentSession) {
        self.session = session
        self.selectedRoot = session.worktrees.first?.wtDir ?? session.path
    }

    var roots: [String] {
        let roots = session.worktrees.map(\.wtDir)
        return roots.isEmpty ? [session.path].filter { !$0.isEmpty } : roots
    }

    var visibleFiles: [DiffFileChange] {
        mode == .local ? files : prFiles
    }

    var additions: Int { visibleFiles.reduce(0) { $0 + $1.additions } }
    var deletions: Int { visibleFiles.reduce(0) { $0 + $1.deletions } }

    var isClean: Bool {
        mode == .local && files.isEmpty && statusEntries.isEmpty
    }

    /// Entries git reports as changed that produced no diff text — submodules,
    /// ignored-but-staged files, permission-only changes.
    var statusOnlyEntries: [GitStatusEntry] {
        let diffed = Set(files.map(\.path))
        return statusEntries.filter { !diffed.contains($0.path) }
    }

    func isCollapsed(_ file: DiffFileChange) -> Bool {
        collapsedFiles.contains(file.path)
    }

    func toggleCollapsed(_ file: DiffFileChange) {
        if collapsedFiles.contains(file.path) {
            collapsedFiles.remove(file.path)
        } else {
            collapsedFiles.insert(file.path)
        }
    }

    func isTruncated(_ file: DiffFileChange) -> Bool {
        file.lineCount > Self.largeFileLineCount && !revealedLargeFiles.contains(file.path)
    }

    func reveal(_ file: DiffFileChange) {
        revealedLargeFiles.insert(file.path)
    }

    func absolutePath(for file: DiffFileChange) -> String {
        selectedRoot.hasSuffix("/")
            ? selectedRoot + file.path
            : selectedRoot + "/" + file.path
    }

    func load() async {
        guard !selectedRoot.isEmpty else { return }
        loading = true
        defer {
            loading = false
            hasLoaded = true
        }
        do {
            let changes = try await api.fetchGitChanges(path: selectedRoot)
            branch = changes.branch
            prURL = changes.prUrl
            statusEntries = GitStatusEntry.parse(changes.status)
            files = DiffParser.files(from: changes.diff)
            applyDefaultCollapse()
            if prURL == nil, mode == .pullRequest { mode = .local }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadPRDiff() async {
        guard prURL != nil else { return }
        loadingPRDiff = true
        prDiffError = nil
        defer { loadingPRDiff = false }
        do {
            prFiles = DiffParser.files(from: try await api.fetchPRDiff(path: selectedRoot))
        } catch {
            prDiffError = error.localizedDescription
        }
    }

    /// Long diffs open collapsed so the pane stays usable, but a poll must not
    /// re-collapse what the reader just opened — only a changed file set does.
    private func applyDefaultCollapse() {
        let signature = files.map { "\($0.path):\($0.additions):\($0.deletions)" }.joined(separator: "|")
        guard signature != fileSignature else { return }
        fileSignature = signature
        selection = nil
        guard files.count > 6 else {
            collapsedFiles = []
            return
        }
        collapsedFiles = Set(files.dropFirst().map(\.path))
    }

    func select(path: String, lineID: Int, extend: Bool) {
        if extend, var current = selection, current.path == path {
            current.focus = lineID
            selection = current
        } else {
            selection = DiffSelection(path: path, anchor: lineID, focus: lineID)
        }
    }

    func snippet(for selection: DiffSelection) -> String {
        guard let file = visibleFiles.first(where: { $0.path == selection.path }) else { return "" }
        return file.hunks
            .flatMap(\.lines)
            .filter { selection.contains($0.id) }
            .map { line in
                switch line.kind {
                case .addition: "+" + line.text
                case .deletion: "-" + line.text
                default: " " + line.text
                }
            }
            .joined(separator: "\n")
    }

    func selectedLineCount(_ selection: DiffSelection) -> Int {
        selection.upper - selection.lower + 1
    }

    func addComment(_ body: String) {
        guard let selection, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let file = visibleFiles.first { $0.path == selection.path }
        let line = file?.hunks
            .flatMap(\.lines)
            .first { $0.id == selection.lower }
            .flatMap { $0.newNumber ?? $0.oldNumber }
        pendingComments.append(
            DiffComment(
                path: selection.path,
                snippet: snippet(for: selection),
                body: body.trimmingCharacters(in: .whitespacesAndNewlines),
                line: line
            )
        )
        self.selection = nil
    }

    func removeComment(_ comment: DiffComment) {
        pendingComments.removeAll { $0.id == comment.id }
    }

    func sendPendingComments() async {
        guard !pendingComments.isEmpty else { return }
        busy = true
        defer { busy = false }
        let message = pendingComments
            .map { comment in
                let where_ = comment.line.map { "\(comment.path):\($0)" } ?? comment.path
                return "In \(where_):\n```\n\(comment.snippet)\n```\n\(comment.body)"
            }
            .joined(separator: "\n\n---\n\n")
        do {
            try await api.sendInput(
                "Please address these review comments:\n\n\(message)",
                to: session.name
            )
            pendingComments = []
            notice = "Sent review comments to the agent."
        } catch {
            self.error = error.localizedDescription
        }
    }

    func push() async {
        busy = true
        defer { busy = false }
        do {
            let result = try await api.pushChanges(path: selectedRoot)
            notice = "Pushed \(result.branch)."
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func createPullRequest(title: String, body: String) async {
        busy = true
        defer { busy = false }
        do {
            let result = try await api.createPullRequest(
                path: selectedRoot,
                title: title,
                body: body
            )
            notice = "Pull request created."
            if let url = URL(string: result.url) {
                NSWorkspace.shared.open(url)
            }
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func sendNote(_ text: String) async {
        do {
            try await api.sendInput(
                "Please review the current changes in \(selectedRoot) and address this note:\n\n\(text)",
                to: session.name
            )
            notice = "Sent note to the agent."
        } catch {
            self.error = error.localizedDescription
        }
    }

    func copyPath(_ file: DiffFileChange) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(absolutePath(for: file), forType: .string)
        notice = "Copied \(file.fileName) path."
    }
}

struct NativeChangesView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.agentDockTheme) private var theme
    @ObservedObject var model: NativeChangesModel
    @State private var showingPR = false
    @State private var prTitle = ""
    @State private var prBody = ""
    @State private var showingNote = false
    @State private var note = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            if !model.pendingComments.isEmpty {
                Divider()
                commentBar
            }
        }
        .task(id: model.selectedRoot) {
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(for: .seconds(10))
            }
        }
        .task(id: pullRequestDiffKey) {
            guard model.mode == .pullRequest else { return }
            await model.loadPRDiff()
        }
        .alert(
            "Changes",
            isPresented: Binding(
                get: { model.error != nil },
                set: { if !$0 { model.error = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.error ?? "")
        }
        .overlay(alignment: .bottom) {
            if let notice = model.notice {
                Text(notice)
                    .font(.callout)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().stroke(.quaternary))
                    .padding(.bottom, 16)
                    .onTapGesture { model.notice = nil }
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        model.notice = nil
                    }
            }
        }
        .sheet(isPresented: $showingPR) { pullRequestSheet }
        .sheet(isPresented: $showingNote) { noteSheet }
    }

    private var pullRequestDiffKey: String {
        "\(model.mode.rawValue)|\(model.prURL ?? "")|\(model.selectedRoot)"
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                if model.roots.count > 1 {
                    Picker("", selection: $model.selectedRoot) {
                        ForEach(model.roots, id: \.self) { root in
                            Text(URL(fileURLWithPath: root).lastPathComponent).tag(root)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 200)
                } else {
                    Text(URL(fileURLWithPath: model.selectedRoot).lastPathComponent)
                        .font(.headline)
                }

                if !model.branch.isEmpty {
                    Label(model.branch, systemImage: "arrow.triangle.branch")
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(.quaternary.opacity(0.5), in: Capsule())
                }

                statsChips

                Spacer()

                if model.loading, model.hasLoaded {
                    ProgressView().controlSize(.small)
                }

                Button { showingNote = true } label: {
                    Label("Note", systemImage: "bubble.left")
                }
                .help("Send a note about these changes to the agent")

                Button { Task { await model.push() } } label: {
                    Label("Push", systemImage: "arrow.up.circle")
                }

                Button {
                    prTitle = model.branch.replacingOccurrences(of: "-", with: " ")
                    showingPR = true
                } label: {
                    Label("Create PR", systemImage: "arrow.triangle.pull")
                }
                .disabled(model.branch.isEmpty || model.prURL != nil)

                Button { Task { await model.load() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help("Refresh")
            }
            .buttonStyle(.borderless)
            .disabled(model.busy)

            if model.prURL != nil {
                HStack(spacing: 10) {
                    Picker("", selection: $model.mode) {
                        ForEach(DiffMode.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 240)

                    if let url = model.prURL, let parsed = URL(string: url) {
                        Link(destination: parsed) {
                            Label(
                                url.replacingOccurrences(of: "https://github.com/", with: ""),
                                systemImage: "arrow.up.forward.square"
                            )
                            .font(.caption)
                        }
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(url, forType: .string)
                            model.notice = "Copied the PR link."
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                        .buttonStyle(.borderless)
                        .help("Copy the PR link")
                    }
                    Spacer()
                }
            }
        }
        .padding(10)
        .background(theme.chrome)
    }

    private var statsChips: some View {
        HStack(spacing: 6) {
            let count = model.visibleFiles.count
            if count > 0 {
                Text("\(count) file\(count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if model.additions > 0 {
                    Text("+\(model.additions)")
                        .font(.caption.monospacedDigit().bold())
                        .foregroundStyle(.green)
                }
                if model.deletions > 0 {
                    Text("−\(model.deletions)")
                        .font(.caption.monospacedDigit().bold())
                        .foregroundStyle(.red)
                }
            }
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if !model.hasLoaded {
            ProgressView("Loading changes…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.mode == .pullRequest {
            pullRequestContent
        } else if model.isClean {
            ContentUnavailableView(
                "Working tree clean",
                systemImage: "checkmark.circle",
                description: Text(model.branch.isEmpty ? model.selectedRoot : "Nothing to review on \(model.branch).")
            )
        } else {
            HSplitView {
                fileSidebar
                    .frame(minWidth: 220, idealWidth: 280, maxWidth: 420)
                diffPane
                    .frame(minWidth: 420)
            }
        }
    }

    @ViewBuilder
    private var pullRequestContent: some View {
        if model.loadingPRDiff {
            ProgressView("Loading pull request diff…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = model.prDiffError {
            ContentUnavailableView {
                Label("No pull request diff", systemImage: "arrow.triangle.pull")
            } description: {
                Text(error)
            } actions: {
                Button("Retry") { Task { await model.loadPRDiff() } }
            }
        } else if model.prFiles.isEmpty {
            ContentUnavailableView(
                "Empty pull request diff",
                systemImage: "arrow.triangle.pull",
                description: Text("gh returned no changes for \(model.branch).")
            )
        } else {
            HSplitView {
                fileSidebar
                    .frame(minWidth: 220, idealWidth: 280, maxWidth: 420)
                diffPane
                    .frame(minWidth: 420)
            }
        }
    }

    private var fileSidebar: some View {
        List {
            Section("Changed files") {
                ForEach(model.visibleFiles) { file in
                    Button {
                        model.collapsedFiles.remove(file.path)
                        model.scrollTarget = file.path
                    } label: {
                        FileSummaryRow(file: file)
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Open in Files") {
                            app.openInFiles(path: model.absolutePath(for: file), line: nil)
                        }
                        Button("Copy Path") { model.copyPath(file) }
                    }
                }
            }

            if model.mode == .local, !model.statusOnlyEntries.isEmpty {
                Section("No diff text") {
                    ForEach(model.statusOnlyEntries) { entry in
                        HStack(spacing: 8) {
                            StatusBadge(label: entry.label)
                            Text(entry.path)
                                .font(.caption.monospaced())
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
    }

    private var diffPane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(model.visibleFiles) { file in
                        FileDiffCard(model: model, file: file) { path, line in
                            app.openInFiles(path: path, line: line)
                        }
                        .id(file.path)
                    }
                }
                .padding(14)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .onChange(of: model.scrollTarget) { _, target in
                guard let target else { return }
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo(target, anchor: .top)
                }
                model.scrollTarget = nil
            }
        }
    }

    private var commentBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "text.bubble")
            Text("\(model.pendingComments.count) review comment\(model.pendingComments.count == 1 ? "" : "s")")
                .font(.callout.bold())

            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(model.pendingComments) { comment in
                        HStack(spacing: 5) {
                            Text(comment.line.map { "\(fileName(comment.path)):\($0)" } ?? fileName(comment.path))
                                .font(.caption.monospaced())
                            Button {
                                model.removeComment(comment)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.quaternary.opacity(0.6), in: Capsule())
                        .help(comment.body)
                    }
                }
            }
            .scrollIndicators(.hidden)

            Button("Clear") { model.pendingComments = [] }
                .buttonStyle(.borderless)

            Button {
                Task { await model.sendPendingComments() }
            } label: {
                if model.busy {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Send to agent", systemImage: "paperplane.fill")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy)
        }
        .padding(10)
        .background(theme.chrome)
    }

    private func fileName(_ path: String) -> String {
        path.components(separatedBy: "/").last ?? path
    }

    // MARK: Sheets

    private var pullRequestSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Create pull request").font(.title2.bold())
            Text("Pushes \(model.branch.isEmpty ? "the current branch" : model.branch) first, then opens the PR in your browser.")
                .font(.callout)
                .foregroundStyle(.secondary)
            TextField("Title", text: $prTitle)
                .textFieldStyle(.roundedBorder)
            TextEditor(text: $prBody)
                .font(.body)
                .frame(height: 180)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            HStack {
                Spacer()
                Button("Cancel") { showingPR = false }
                Button("Push & Create") {
                    showingPR = false
                    Task { await model.createPullRequest(title: prTitle, body: prBody) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(prTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 560)
    }

    private var noteSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Send a changes note").font(.title2.bold())
            TextEditor(text: $note)
                .font(.body)
                .frame(height: 130)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            HStack {
                Spacer()
                Button("Cancel") { showingNote = false }
                Button("Send") {
                    let text = note
                    note = ""
                    showingNote = false
                    Task { await model.sendNote(text) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 520)
    }
}

private struct FileSummaryRow: View {
    let file: DiffFileChange

    var body: some View {
        HStack(spacing: 8) {
            StatusBadge(label: file.changeLabel)
            VStack(alignment: .leading, spacing: 1) {
                Text(file.fileName)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !file.directory.isEmpty {
                    Text(file.directory)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer(minLength: 4)
            if file.additions > 0 {
                Text("+\(file.additions)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.green)
            }
            if file.deletions > 0 {
                Text("−\(file.deletions)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.red)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct StatusBadge: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption2.bold())
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(color.opacity(0.16), in: RoundedRectangle(cornerRadius: 4))
    }

    private var color: Color {
        switch label {
        case "new", "added": .green
        case "deleted": .red
        case "renamed": .purple
        case "binary": .secondary
        default: .orange
        }
    }
}

private struct FileDiffCard: View {
    @ObservedObject var model: NativeChangesModel
    let file: DiffFileChange
    let onOpen: (String, Int?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !model.isCollapsed(file) {
                Divider()
                hunks(for: file)
            }
        }
        .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary.opacity(0.7)))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                model.toggleCollapsed(file)
            } label: {
                Image(systemName: model.isCollapsed(file) ? "chevron.right" : "chevron.down")
                    .font(.caption.bold())
                    .frame(width: 14)
            }
            .buttonStyle(.borderless)

            StatusBadge(label: file.changeLabel)

            Text(file.path)
                .font(.callout.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
                .help(file.path)

            if let previous = file.previousPath {
                Text("was \(previous)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 6)

            if file.additions > 0 {
                Text("+\(file.additions)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.green)
            }
            if file.deletions > 0 {
                Text("−\(file.deletions)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.red)
            }

            Button {
                onOpen(model.absolutePath(for: file), firstChangedLine)
            } label: {
                Image(systemName: "arrow.up.forward.app")
            }
            .buttonStyle(.borderless)
            .help("Open in the Files editor")

            Button {
                model.copyPath(file)
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .help("Copy the absolute path")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
    }

    private var firstChangedLine: Int? {
        file.hunks
            .flatMap(\.lines)
            .first { $0.kind == .addition }?
            .newNumber
            ?? file.hunks.first?.lines.first?.newNumber
    }

    @ViewBuilder
    private func hunks(for file: DiffFileChange) -> some View {
        if file.isBinary {
            Text("Binary file — no text diff.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(12)
        } else if model.isTruncated(file) {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(file.lineCount) diff lines. Rendering this file will slow the pane down.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Show anyway") { model.reveal(file) }
                    Button("Open in Files") {
                        onOpen(model.absolutePath(for: file), firstChangedLine)
                    }
                }
            }
            .padding(12)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(file.hunks) { hunk in
                    HStack(spacing: 8) {
                        Text(hunk.range)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                        if !hunk.context.isEmpty {
                            Text(hunk.context)
                                .font(.caption.monospaced())
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color.accentColor.opacity(0.09))

                    ForEach(hunk.lines) { line in
                        DiffLineRow(
                            line: line,
                            selected: model.selection?.path == file.path
                                && model.selection?.contains(line.id) == true,
                            onSelect: { extend in
                                model.select(path: file.path, lineID: line.id, extend: extend)
                            },
                            onOpen: {
                                onOpen(model.absolutePath(for: file), line.newNumber ?? line.oldNumber)
                            }
                        )

                        if let selection = model.selection,
                           selection.path == file.path,
                           selection.upper == line.id {
                            DiffCommentComposer(
                                lineCount: model.selectedLineCount(selection),
                                onCancel: { model.selection = nil },
                                onSubmit: { model.addComment($0) }
                            )
                            .id(selection)
                        }
                    }
                }
            }
        }
    }
}

private struct DiffLineRow: View {
    let line: DiffLine
    let selected: Bool
    let onSelect: (Bool) -> Void
    let onOpen: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Button {
                onSelect(NSEvent.modifierFlags.contains(.shift))
            } label: {
                HStack(spacing: 0) {
                    number(line.oldNumber)
                    number(line.newNumber)
                    Text(sign)
                        .font(gutterFont)
                        .foregroundStyle(signColor)
                        .frame(width: 14, alignment: .center)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Click to select, Shift-click to extend, then comment")

            Text(line.text.isEmpty ? " " : line.text)
                .font(.system(size: 12, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 10)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 1)
        .background(background)
        .overlay(alignment: .leading) {
            if selected {
                Rectangle()
                    .fill(Color.accentColor)
                    .frame(width: 2)
            }
        }
        .contextMenu {
            Button("Open in Files") { onOpen() }
            Button("Copy Line") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(line.text, forType: .string)
            }
        }
    }

    private var gutterFont: Font { .system(size: 11, design: .monospaced) }

    private func number(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "")
            .font(gutterFont)
            .foregroundStyle(.tertiary)
            .frame(width: 44, alignment: .trailing)
            .padding(.trailing, 6)
    }

    private var sign: String {
        switch line.kind {
        case .addition: "+"
        case .deletion: "−"
        case .meta: "⋯"
        case .context: ""
        }
    }

    private var signColor: Color {
        switch line.kind {
        case .addition: .green
        case .deletion: .red
        default: .secondary
        }
    }

    private var background: Color {
        if selected { return Color.accentColor.opacity(0.18) }
        switch line.kind {
        case .addition: return .green.opacity(0.11)
        case .deletion: return .red.opacity(0.11)
        default: return .clear
        }
    }
}

private struct DiffCommentComposer: View {
    let lineCount: Int
    let onCancel: () -> Void
    let onSubmit: (String) -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Comment on \(lineCount) line\(lineCount == 1 ? "" : "s")")
                .font(.caption.bold())
                .foregroundStyle(.secondary)
            TextField("What should the agent change here?", text: $draft, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { submit() }
            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                Button("Add", action: submit)
                    .buttonStyle(.borderedProminent)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(10)
        .background(Color.accentColor.opacity(0.07))
        .onAppear { focused = true }
    }

    private func submit() {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        onSubmit(draft)
        draft = ""
    }
}
