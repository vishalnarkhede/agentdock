import AppKit
import CodeEditSourceEditor
import SwiftUI

struct SearchLocation: Equatable {
    let path: String
    let line: Int?
}

private struct ExplorerTreeRow: Identifiable {
    let path: String
    let entry: FileEntry
    let depth: Int

    var id: String { path }
}

@MainActor
final class FileExplorerStateStore {
    private var models: [String: NativeFileExplorerModel] = [:]

    func model(for session: AgentSession) -> NativeFileExplorerModel {
        if let model = models[session.id] {
            model.update(session: session)
            return model
        }
        let model = NativeFileExplorerModel(session: session)
        models[session.id] = model
        return model
    }

    func remove(sessionID: String) {
        models.removeValue(forKey: sessionID)
    }
}

@MainActor
final class NativeFileExplorerModel: ObservableObject {
    @Published private(set) var session: AgentSession
    @Published var entries: [String: [FileEntry]] = [:]
    @Published var expanded: Set<String> = []
    @Published var document: OpenFileDocument?
    @Published var draft = ""
    @Published var search = ""
    @Published var searchResults: FileSearchPayload?
    @Published var searchQuery = ""
    @Published var searching = false
    @Published var loading = false
    @Published var saving = false
    @Published var error: String?
    @Published var markdownPreview = true
    @Published var conflict: WriteFileResult?
    @Published var editorState = SourceEditorState()
    @Published var outline: [DocSymbol] = []
    @Published var showingOutline = false
    @Published var navBusy = false
    @Published var editorEpoch = 0
    @Published var noteSelection: FileCodeSelection?
    @Published var noteSending = false
    @Published var notice: String?
    /// The file and line the reader last jumped to, so the search list can show
    /// where they are instead of losing the place.
    @Published var activeHit: SearchLocation?
    @Published private(set) var editorStorage = NSTextStorage()

    let jumpBridge = JumpToDefinitionBridge()
    let editorBridge = NativeEditorBridge()
    private let api = APIClient()
    private var history: [NavSpot] = []
    private var historyIndex = -1
    private var loaded = false
    private var keyMonitor: Any?
    private var searchTask: Task<Void, Never>?
    private var applyingEditorText = false
    private var definitionCache: [String: (lookup: DefinitionLookup, at: Date)] = [:]
    private var usageCache: [String: (hits: [ContentSearchHit], at: Date)] = [:]
    private static let maxSpots = 50
    /// The server rebuilds its symbol index every 60s, so a shorter window here
    /// never serves an answer the server would not have given anyway.
    private static let lookupTTL: TimeInterval = 45

    init(session: AgentSession) {
        self.session = session
        jumpBridge.model = self
        editorBridge.onTextChange = { [weak self] text in
            guard let self, !self.applyingEditorText else { return }
            self.draft = text
        }
    }

    var roots: [String] {
        let worktrees = session.worktrees.map(\.wtDir)
        return worktrees.isEmpty ? [session.path].filter { !$0.isEmpty } : worktrees
    }

    var canGoBack: Bool { historyIndex > 0 }
    var canGoForward: Bool { historyIndex >= 0 && historyIndex < history.count - 1 }
    var currentLine: Int {
        max(editorState.cursorPositions?.first?.start.line ?? 1, 1)
    }
    var dirty: Bool { document.map { draft != $0.content } ?? false }
    var codeSelection: FileCodeSelection? {
        guard let position = editorState.cursorPositions?.first(where: {
            $0.range.location != NSNotFound && $0.range.length > 0
        }) else { return nil }
        return FileNoteMessage.selection(in: draft, range: position.range)
    }
    var isMarkdown: Bool {
        document?.language == "markdown"
            || document?.path.lowercased().hasSuffix(".md") == true
    }

    fileprivate func flattenedRows(root: String) -> [ExplorerTreeRow] {
        var rows: [ExplorerTreeRow] = []
        func appendChildren(of directory: String, depth: Int) {
            for entry in entries[directory] ?? [] {
                let path = directory + "/" + entry.name
                rows.append(.init(path: path, entry: entry, depth: depth))
                if entry.type == .dir, expanded.contains(path) {
                    appendChildren(of: path, depth: depth + 1)
                }
            }
        }
        appendChildren(of: root, depth: 0)
        return rows
    }

    func update(session: AgentSession) {
        self.session = session
    }

    func loadIfNeeded() async {
        guard !loaded else { return }
        loaded = true
        expanded = Set(roots)
        await withTaskGroup(of: (String, [FileEntry]?).self) { group in
            for root in roots {
                group.addTask {
                    (root, try? await self.api.listDirectory(root, roots: self.roots))
                }
            }
            for await (root, result) in group {
                if let result { entries[root] = result }
            }
        }
    }

    func toggleDirectory(_ path: String) async {
        if expanded.contains(path) {
            expanded.remove(path)
            return
        }
        expanded.insert(path)
        if entries[path] == nil {
            do {
                entries[path] = try await api.listDirectory(path, roots: roots)
            } catch {
                self.report(error)
            }
        }
    }

    func open(_ path: String, line: Int? = nil, recordHistory: Bool = true) async {
        guard !dirty || path == document?.path else {
            error = "Save or discard your current edits before opening another file."
            return
        }
        if recordHistory { markCurrentLine() }
        activeHit = SearchLocation(path: path, line: line)
        if document?.path == path, !dirty {
            if let line { editorBridge.reveal(line: line) }
            if recordHistory { recordVisit(path: path, line: line ?? currentLine, external: false) }
            return
        }
        loading = true
        defer { loading = false }
        do {
            let opened = try await api.readFile(path, roots: roots)
            apply(opened, line: line, recordHistory: recordHistory)
            await loadOutline(for: opened.path)
        } catch {
            self.report(error)
        }
    }

    func openExternal(_ path: String) async {
        guard !dirty else {
            error = "Save or discard your current edits before opening another file."
            return
        }
        loading = true
        defer { loading = false }
        do {
            let opened = try await api.openExternalFile(path)
            apply(opened, line: nil, recordHistory: true)
            outline = []
        } catch {
            self.report(error)
        }
    }

    func goBack() async {
        guard canGoBack, !dirty else {
            if dirty { error = "Save or discard your edits before navigating back." }
            return
        }
        markCurrentLine()
        historyIndex -= 1
        await replay(history[historyIndex])
    }

    func goForward() async {
        guard canGoForward, !dirty else {
            if dirty { error = "Save or discard your edits before navigating forward." }
            return
        }
        markCurrentLine()
        historyIndex += 1
        await replay(history[historyIndex])
    }

    func jumpToSymbolAtCursor() async {
        guard let document else { return }
        let source = draft as NSString
        let cursor = editorState.cursorPositions?.first
        let location: Int
        if let cursor, cursor.range.location != NSNotFound, cursor.range.location < source.length {
            location = cursor.range.location
        } else {
            location = rangeForLine(max(cursor?.start.line ?? 1, 1), in: draft).location
        }
        guard let name = Identifier.at(NSRange(location: max(0, location), length: 0), in: source) else { return }

        let line = max(cursor?.start.line ?? 1, 1)
        let col = max(cursor?.start.column ?? 1, 1)
        navBusy = true
        defer { navBusy = false }

        let position = CodePosition(
            path: document.path,
            line: line,
            col: col,
            roots: roots.joined(separator: ","),
            text: dirty ? draft : nil
        )
        do {
            let lookup = try await api.findDefinition(at: position)
            if lookup.source == "warming" {
                notice = "Language server is indexing this workspace. Try again in a moment."
                return
            }
            guard lookup.source == "lsp" else {
                await navigateToSymbol(name, atLine: line)
                return
            }
            let elsewhere = lookup.candidates.filter { $0.path != document.path || abs($0.line - line) > 1 }
            if let only = elsewhere.first, elsewhere.count == 1 {
                await open(only.path, line: only.line)
                return
            }
            if !elsewhere.isEmpty {
                showCandidates(elsewhere, query: name)
                return
            }
            // Already on the declaration: the useful answer is who calls it.
            let hits = try await api.findReferences(at: position)
            showReferences(hits, query: name)
        } catch {
            self.report(error)
        }
    }

    private func showCandidates(_ candidates: [CodeSymbol], query: String) {
        search = query
        searchQuery = query
        searchResults = FileSearchPayload(
            files: [],
            content: candidates.map {
                ContentSearchHit(path: $0.path, line: $0.line, text: $0.detail ?? "\($0.kind) \($0.name)")
            },
            truncated: SearchTruncation(files: false, content: false),
            tookMs: 0,
            indexed: 0,
            tool: "definitions"
        )
    }

    private func showReferences(_ hits: [CodeReference], query: String) {
        search = query
        searchQuery = query
        searchResults = FileSearchPayload(
            files: [],
            content: hits.map { ContentSearchHit(path: $0.path, line: $0.line, text: $0.text) },
            truncated: SearchTruncation(files: false, content: false),
            tookMs: 0,
            indexed: 0,
            tool: "references"
        )
    }

    func navigateToSymbol(_ name: String, atLine: Int?) async {
        navBusy = true
        defer { navBusy = false }
        do {
            let lookup = try await lookupDefinition(name)
            let here = lookup.candidates.filter { $0.path == document?.path }
            let onDefinition = atLine.map { line in here.contains { abs($0.line - line) <= 1 } } ?? false
            if lookup.candidates.isEmpty || onDefinition {
                search = name
                searchQuery = name
                searchResults = try await api.findFiles(name, roots: roots)
                return
            }
            if let only = lookup.candidates.first, lookup.candidates.count == 1 {
                await open(only.path, line: only.line)
                return
            }
            searchResults = FileSearchPayload(
                files: lookup.candidates.map {
                    FileSearchHit(
                        path: $0.path,
                        rel: $0.file,
                        root: $0.root ?? "",
                        name: $0.name,
                        score: $0.score ?? 0,
                        positions: []
                    )
                },
                content: lookup.candidates.map {
                    ContentSearchHit(path: $0.path, line: $0.line, text: "\($0.kind) \($0.name)")
                },
                truncated: SearchTruncation(files: false, content: false),
                tookMs: 0,
                indexed: lookup.indexed ?? 0,
                tool: "symbols"
            )
        } catch {
            self.report(error)
        }
    }

    /// Cmd-click. Asks the language server about the exact position, and shows
    /// references instead when the click landed on the declaration itself —
    /// which is what "go to definition" on a definition should mean.
    func definitionLinks(name: String, line: Int, col: Int) async -> [JumpToDefinitionLink]? {
        guard let document else { return nil }
        navBusy = true
        defer { navBusy = false }

        let position = CodePosition(
            path: document.path,
            line: line,
            col: col,
            roots: roots.joined(separator: ","),
            text: dirty ? draft : nil
        )

        do {
            let lookup = try await api.findDefinition(at: position)
            if lookup.source == "warming" {
                notice = "Language server is indexing this workspace. Cmd-click again in a moment."
                return nil
            }
            if lookup.source == "lsp" {
                let elsewhere = lookup.candidates.filter {
                    $0.path != document.path || abs($0.line - line) > 1
                }
                if !elsewhere.isEmpty { return elsewhere.map(link(for:)) }
                let hits = try await api.findReferences(at: position)
                return referenceLinks(name: name, hits: hits)
            }
            // No language server for this file: the regex index answered, so
            // keep the name-based behaviour including its usage fallback.
            let here = lookup.candidates.filter { $0.path == document.path }
            let onDefinition = here.contains { abs($0.line - line) <= 1 }
            if lookup.candidates.isEmpty || onDefinition {
                let usages = try await lookupUsages(name)
                return referenceLinks(
                    name: name,
                    hits: usages.map { CodeReference(path: $0.path, rel: nil, line: $0.line, col: nil, text: $0.text) }
                )
            }
            return lookup.candidates.map(link(for:))
        } catch {
            return nil
        }
    }

    private func link(for symbol: CodeSymbol) -> JumpToDefinitionLink {
        JumpToDefinitionLink(
            url: Self.jumpURL(path: symbol.path, line: symbol.line),
            targetRange: CursorPosition(line: symbol.line, column: 1),
            typeName: symbol.name,
            sourcePreview: symbol.detail ?? "\(symbol.kind) \(symbol.name)",
            documentation: symbol.container
        )
    }

    private func referenceLinks(name: String, hits: [CodeReference]) -> [JumpToDefinitionLink]? {
        let links = hits.prefix(60).map { hit in
            JumpToDefinitionLink(
                url: Self.jumpURL(path: hit.path, line: hit.line),
                targetRange: CursorPosition(line: hit.line, column: 1),
                typeName: name,
                sourcePreview: hit.text.trimmingCharacters(in: .whitespaces),
                documentation: hit.rel ?? URL(fileURLWithPath: hit.path).lastPathComponent
            )
        }
        return links.isEmpty ? nil : Array(links)
    }

    /// Every jump target carries a URL, including one inside the open file.
    ///
    /// CodeEdit's single-result path uses `targetRange.range` verbatim, which is
    /// `NSNotFound` for a line-and-column position, so a URL-less link jumps
    /// nowhere. Routing through the delegate also keeps one code path for
    /// history and scrolling. The line fragment only exists to keep the link ids
    /// distinct — several hits in one file would otherwise share an id in the
    /// chooser popover.
    private static func jumpURL(path: String, line: Int) -> URL? {
        var components = URLComponents()
        components.scheme = "file"
        components.path = path
        components.fragment = "L\(line)"
        return components.url ?? URL(fileURLWithPath: path)
    }

    private func lookupDefinition(_ name: String) async throws -> DefinitionLookup {
        let key = "\(document?.path ?? "")|\(name)"
        if let hit = definitionCache[key], Date().timeIntervalSince(hit.at) < Self.lookupTTL {
            return hit.lookup
        }
        let lookup = try await api.findDefinition(name: name, roots: roots, from: document?.path)
        definitionCache[key] = (lookup, Date())
        return lookup
    }

    private func lookupUsages(_ name: String) async throws -> [ContentSearchHit] {
        if let hit = usageCache[name], Date().timeIntervalSince(hit.at) < Self.lookupTTL {
            return hit.hits
        }
        let hits = try await api.findUsages(name, roots: roots)
        usageCache[name] = (hits, Date())
        return hits
    }

    func revealSymbol(_ symbol: DocSymbol) {
        editorBridge.reveal(line: symbol.line)
        if let path = document?.path {
            activeHit = SearchLocation(path: path, line: symbol.line)
        }
        showingOutline = false
    }

    /// Surfaces a failure, unless it is only this work being replaced.
    ///
    /// A debounced search cancels the request in flight on every keystroke, and
    /// URLSession reports that as an error whose entire message is the word
    /// "cancelled" — which was putting an alert on screen for each character
    /// typed. The same is true of a jump the reader moved on from.
    func report(_ error: Error) {
        if error is CancellationError { return }
        if let urlError = error as? URLError, urlError.code == .cancelled { return }
        self.error = error.localizedDescription
    }

    /// Runs the query a moment after typing stops, and keeps the previous list
    /// on screen until the next one is ready.
    func scheduleSearch() {
        searchTask?.cancel()
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchTask = nil
            searching = false
            searchQuery = ""
            searchResults = nil
            return
        }
        searchTask = Task { @MainActor in
            // Long enough to collapse a burst of key events, short enough that
            // filename matches still feel attached to the keystroke.
            try? await Task.sleep(for: .milliseconds(70))
            guard !Task.isCancelled else { return }
            await performSearch(query: query)
        }
    }

    func performSearch() async {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchQuery = ""
            searchResults = nil
            return
        }
        await performSearch(query: query)
    }

    /// File names come from the in-memory path index first; content follows.
    /// VS Code uses the same staged UX so a full repository scan never holds
    /// the first useful pixels hostage.
    private func performSearch(query: String) async {
        searching = true
        // A newer search has already taken over the spinner by the time a
        // cancelled one unwinds, so it must not switch it off.
        defer { if !Task.isCancelled { searching = false } }
        do {
            let names = try await api.findFiles(query, roots: roots, kind: "name", limit: 80)
            guard !Task.isCancelled,
                  search.trimmingCharacters(in: .whitespacesAndNewlines) == query else { return }
            searchQuery = query
            searchResults = names

            let content = try await api.findFiles(query, roots: roots, kind: "content", limit: 200)
            guard !Task.isCancelled,
                  search.trimmingCharacters(in: .whitespacesAndNewlines) == query else { return }
            searchResults = FileSearchPayload(
                files: names.files,
                content: content.content,
                truncated: SearchTruncation(
                    files: names.truncated.files,
                    content: content.truncated.content
                ),
                tookMs: names.tookMs + content.tookMs,
                indexed: names.indexed,
                tool: content.tool
            )
        } catch {
            self.report(error)
        }
    }

    func clearSearch() {
        searchTask?.cancel()
        searchTask = nil
        search = ""
        searchQuery = ""
        searchResults = nil
        searching = false
    }

    func save(force: Bool = false) async {
        guard let document, !document.readOnly, dirty else { return }
        saving = true
        defer { saving = false }
        do {
            let result = try await api.writeFile(
                document,
                roots: roots,
                content: draft,
                force: force
            )
            if result.conflict == true {
                conflict = result
                return
            }
            guard let version = result.version, let size = result.size else { return }
            self.document = OpenFileDocument(
                path: document.path,
                content: draft,
                language: document.language,
                size: size,
                version: version,
                readOnly: false
            )
            conflict = nil
            definitionCache.removeAll()
            usageCache.removeAll()
        } catch {
            self.report(error)
        }
    }

    func composeNoteOnSelection() {
        noteSelection = codeSelection
    }

    func sendSelectionNote(_ note: String) async -> Bool {
        guard let document, let selection = noteSelection else { return false }
        let cleanNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanNote.isEmpty else { return false }
        noteSending = true
        defer { noteSending = false }
        let message = FileNoteMessage.build(
            path: FileNoteMessage.relativePath(document.path, roots: roots),
            selection: selection,
            note: cleanNote,
            language: document.language.isEmpty ? nil : document.language
        )
        do {
            try await api.sendInput(message, to: session.name)
            noteSelection = nil
            notice = "Sent \(selection.lineLabel) to \(session.displayName)."
            return true
        } catch {
            self.report(error)
            return false
        }
    }

    func reloadFromConflict() {
        guard let conflict, let content = conflict.currentContent,
              let version = conflict.currentVersion, let document else { return }
        self.document = OpenFileDocument(
            path: document.path,
            content: content,
            language: document.language,
            size: content.utf8.count,
            version: version,
            readOnly: false
        )
        replaceEditorText(with: content)
        self.conflict = nil
    }

    func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            let command = event.modifierFlags.contains(.command)
            let option = event.modifierFlags.contains(.option)
            guard command, !option else { return event }
            switch Int(event.keyCode) {
            case 33: // [
                Task { @MainActor in await self.goBack() }
                return nil
            case 30: // ]
                Task { @MainActor in await self.goForward() }
                return nil
            case 46 where event.modifierFlags.contains(.shift): // M
                Task { @MainActor in self.composeNoteOnSelection() }
                return self.codeSelection == nil ? event : nil
            default:
                return event
            }
        }
    }

    func removeKeyMonitor() {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
    }

    func toggleFindPanel() {
        var next = editorState
        next.findPanelVisible = !(editorState.findPanelVisible ?? false)
        editorState = next
    }

    /// Opening a file leaves the search list alone: the reader picked a result to
    /// look at it, not to lose the other nine.
    private func apply(_ opened: OpenFileDocument, line: Int?, recordHistory: Bool) {
        document = opened
        replaceEditorText(with: opened.content)
        noteSelection = nil
        // A jump asked for a line, and a rendered preview has no lines to show.
        markdownPreview = line == nil
        editorState = SourceEditorState(
            cursorPositions: [CursorPosition(line: max(line ?? 1, 1), column: 1)]
        )
        editorEpoch += 1
        if let line {
            editorBridge.reveal(line: line)
        } else {
            editorBridge.cancelPendingReveal()
        }
        if recordHistory {
            recordVisit(path: opened.path, line: line ?? 1, external: false)
        }
    }

    /// CodeEdit's own example uses NSTextStorage for non-trivial files. A
    /// Binding<String> makes SwiftUI compare the whole document whenever any
    /// observed state changes, including cursor movement and navigation.
    private func replaceEditorText(with text: String) {
        applyingEditorText = true
        // Replace the storage object instead of mutating the one still attached
        // to the outgoing editor. Mutating it makes the old language highlighter
        // parse the new file, then the incoming highlighter parses it again.
        editorStorage = NSTextStorage(string: text)
        draft = text
        applyingEditorText = false
    }

    private func markCurrentLine() {
        guard let path = document?.path, history.indices.contains(historyIndex) else { return }
        history[historyIndex] = NavSpot(path: path, line: currentLine, external: history[historyIndex].external)
    }

    private func recordVisit(path: String, line: Int, external: Bool) {
        let spot = NavSpot(path: path, line: max(line, 1), external: external)
        if historyIndex >= 0, historyIndex < history.count - 1 {
            history.removeSubrange((historyIndex + 1)...)
        }
        if history.last != spot {
            history.append(spot)
        }
        if history.count > Self.maxSpots {
            history.removeFirst(history.count - Self.maxSpots)
        }
        historyIndex = history.count - 1
    }

    private func replay(_ spot: NavSpot) async {
        await open(spot.path, line: spot.line, recordHistory: false)
    }

    private func loadOutline(for path: String) async {
        do {
            outline = try await api.documentSymbols(path: path, roots: roots)
        } catch {
            outline = []
        }
    }

    private func rangeForLine(_ line: Int, in content: String) -> NSRange {
        let source = content as NSString
        var location = 0
        for _ in 1..<max(1, line) {
            let next = source.range(
                of: "\n",
                range: NSRange(location: location, length: source.length - location)
            )
            if next.location == NSNotFound { break }
            location = next.location + 1
        }
        let end = source.range(
            of: "\n",
            range: NSRange(location: location, length: source.length - location)
        )
        return NSRange(
            location: location,
            length: (end.location == NSNotFound ? source.length : end.location) - location
        )
    }
}

struct NativeFileExplorerView: View {
    @EnvironmentObject private var app: AppModel
    @Environment(\.agentDockTheme) private var theme
    @ObservedObject var model: NativeFileExplorerModel
    @State private var externalPath = ""
    @State private var showingExternalOpen = false
    @State private var showingFind = false
    @State private var noteDraft = ""

    var body: some View {
        HSplitView {
            sidebar
                .frame(minWidth: 220, idealWidth: 280, maxWidth: 420)
                .frame(maxHeight: .infinity)
            editor
                .frame(minWidth: 420)
                .frame(maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await model.loadIfNeeded() }
        .onAppear { model.installKeyMonitor() }
        .onDisappear { model.removeKeyMonitor() }
        .popover(isPresented: $model.showingOutline, arrowEdge: .bottom) {
            outlineList
                .frame(width: 360, height: 420)
        }
        .alert(
            "Files",
            isPresented: Binding(
                get: { model.error != nil },
                set: { if !$0 { model.error = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.error ?? "")
        }
        .confirmationDialog(
            "This file changed on disk",
            isPresented: Binding(
                get: { model.conflict != nil },
                set: { if !$0 { model.conflict = nil } }
            )
        ) {
            Button("Reload agent's version") { model.reloadFromConflict() }
            Button("Overwrite anyway", role: .destructive) {
                Task { await model.save(force: true) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Reload to keep the agent's changes, or overwrite them with your editor contents.")
        }
        .sheet(isPresented: $showingExternalOpen) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Open absolute path").font(.title2.bold())
                Text("Files outside this session open read-only.")
                    .foregroundStyle(.secondary)
                TextField("/absolute/path/to/file", text: $externalPath)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(openExternal)
                HStack {
                    Spacer()
                    Button("Cancel") { showingExternalOpen = false }
                    Button("Open", action: openExternal)
                        .buttonStyle(.borderedProminent)
                }
            }
            .padding(24)
            .frame(width: 500)
        }
        .overlay(alignment: .bottom) {
            if let notice = model.notice {
                Text(notice)
                    .font(.callout)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 12)
                    .task {
                        try? await Task.sleep(for: .seconds(3))
                        model.notice = nil
                    }
            }
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search files and contents", text: $model.search)
                    .textFieldStyle(.plain)
                    .onSubmit { Task { await model.performSearch() } }
                    .onChange(of: model.search) { model.scheduleSearch() }
                if model.searching {
                    ProgressView().controlSize(.small)
                }
                if model.searchResults != nil || !model.search.isEmpty {
                    Button {
                        model.clearSearch()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .help("Clear the search and show the file tree")
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(theme.input, in: RoundedRectangle(cornerRadius: 6))
            .padding(8)

            Divider()

            if let results = model.searchResults {
                searchResultList(results)
            } else {
                List {
                    ForEach(model.roots, id: \.self) { root in
                        Section(URL(fileURLWithPath: root).lastPathComponent) {
                            ForEach(model.flattenedRows(root: root)) { row in
                                Button {
                                    if row.entry.type == .dir {
                                        Task { await model.toggleDirectory(row.path) }
                                    } else {
                                        Task { await model.open(row.path) }
                                    }
                                } label: {
                                    HStack(spacing: 6) {
                                        Color.clear.frame(width: CGFloat(row.depth * 12), height: 1)
                                        Image(systemName: row.entry.type == .dir
                                            ? (model.expanded.contains(row.path) ? "folder.fill" : "folder")
                                            : "doc")
                                        Text(row.entry.name).lineLimit(1)
                                        Spacer()
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .scrollContentBackground(.hidden)
                .background(theme.background)
            }

            Divider()
            HStack {
                Button {
                    showingExternalOpen = true
                } label: {
                    Label("Open Path", systemImage: "doc.badge.plus")
                }
                .buttonStyle(.borderless)
                Spacer()
                if let results = model.searchResults {
                    Text("\(results.files.count) files · \(results.content.count) lines")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
        }
        .background(theme.background)
    }

    /// Content hits are grouped under one header per file, so a file with twelve
    /// matches reads as one entry rather than twelve repetitions of its path.
    private func searchResultList(_ results: FileSearchPayload) -> some View {
        List {
            if !results.files.isEmpty {
                Section("Files") {
                    ForEach(results.files) { hit in
                        Button {
                            Task { await model.open(hit.path) }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "doc")
                                Text(hit.rel)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(rowBackground(path: hit.path, line: nil))
                    }
                }
            }
            ForEach(contentGroups(results.content), id: \.path) { group in
                Section {
                    ForEach(group.hits) { hit in
                        Button {
                            Task { await model.open(hit.path, line: hit.line) }
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("\(hit.line)")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .frame(minWidth: 34, alignment: .trailing)
                                Text(hit.text.trimmingCharacters(in: .whitespaces))
                                    .font(.caption.monospaced())
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(rowBackground(path: hit.path, line: hit.line))
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text(URL(fileURLWithPath: group.path).lastPathComponent)
                            .font(.caption.bold())
                        Text("\(group.hits.count)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if results.files.isEmpty, results.content.isEmpty {
                Text("No matches for “\(model.searchQuery)”")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
    }

    @ViewBuilder
    private func rowBackground(path: String, line: Int?) -> some View {
        if model.activeHit == SearchLocation(path: path, line: line) {
            Color.accentColor.opacity(0.22)
        } else {
            Color.clear
        }
    }

    private func contentGroups(_ hits: [ContentSearchHit]) -> [(path: String, hits: [ContentSearchHit])] {
        var order: [String] = []
        var byPath: [String: [ContentSearchHit]] = [:]
        for hit in hits {
            if byPath[hit.path] == nil { order.append(hit.path) }
            byPath[hit.path, default: []].append(hit)
        }
        return order.map { ($0, byPath[$0] ?? []) }
    }

    @ViewBuilder
    private var editor: some View {
        if let document = model.document {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Button { Task { await model.goBack() } } label: {
                        Image(systemName: "chevron.left")
                    }
                    .disabled(!model.canGoBack)
                    Button { Task { await model.goForward() } } label: {
                        Image(systemName: "chevron.right")
                    }
                    .disabled(!model.canGoForward)

                    Text(document.path)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)

                    if document.readOnly {
                        Text("READ ONLY")
                            .font(.caption2.bold())
                            .foregroundStyle(.orange)
                    }
                    if model.dirty {
                        Circle().fill(.orange).frame(width: 7, height: 7)
                    }
                    if model.navBusy {
                        ProgressView().controlSize(.small)
                    }
                    Spacer()

                    if model.isMarkdown {
                        Picker("", selection: $model.markdownPreview) {
                            Text("Preview").tag(true)
                            Text("Source").tag(false)
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 150)
                    }

                    Button {
                        model.showingOutline = true
                    } label: {
                        Label("Outline", systemImage: "list.bullet.indent")
                    }
                    .disabled(model.outline.isEmpty)
                    .help("Jump to a symbol in this file")
                    .keyboardShortcut("o", modifiers: [.command, .shift])

                    Button {
                        Task { await model.jumpToSymbolAtCursor() }
                    } label: {
                        Label("Definition", systemImage: "arrow.right.to.line")
                    }
                    .help("Go to definition or usages of the symbol at the cursor (⌃⌘J or ⌘-click)")
                    .keyboardShortcut("j", modifiers: [.command, .control])

                    Button {
                        model.toggleFindPanel()
                    } label: {
                        Label("Find", systemImage: "magnifyingglass")
                    }
                    .keyboardShortcut("f", modifiers: .command)
                    Button {
                        Task { await model.save() }
                    } label: {
                        if model.saving {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("Save", systemImage: "square.and.arrow.down")
                        }
                    }
                    .disabled(document.readOnly || !model.dirty || model.saving)
                    .keyboardShortcut("s", modifiers: .command)
                }
                .buttonStyle(.borderless)
                .padding(8)
                .background(theme.chrome)

                Divider()

                if model.isMarkdown, model.markdownPreview {
                    ScrollView {
                        Text(markdownText(model.draft))
                            .textSelection(.enabled)
                            .frame(maxWidth: 900, alignment: .leading)
                            .padding(24)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    NativeCodeEditor(
                        storage: model.editorStorage,
                        path: document.path,
                        editable: !document.readOnly,
                        state: $model.editorState,
                        jumpBridge: model.jumpBridge,
                        editorBridge: model.editorBridge,
                        epoch: model.editorEpoch
                    )
                }

                if !(model.isMarkdown && model.markdownPreview), model.noteSelection != nil {
                    selectionNoteComposer
                } else if !(model.isMarkdown && model.markdownPreview), let selection = model.codeSelection {
                    selectionNoteBar(selection)
                }
            }
        } else if model.loading {
            ProgressView("Opening file…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView(
                "Choose a file",
                systemImage: "doc.text.magnifyingglass",
                description: Text("Browse the tree or search file names and contents.")
            )
        }
    }

    private func selectionNoteBar(_ selection: FileCodeSelection) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "selection.pin.in.out")
                .foregroundStyle(.secondary)
            Text(selection.lineLabel)
                .font(.caption.monospaced())
            Text("\(selection.text.count) characters")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                noteDraft = ""
                model.composeNoteOnSelection()
            } label: {
                Label("Note to agent", systemImage: "paperplane")
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut("m", modifiers: [.command, .shift])
            .help("Send the selected code and a comment to the agent (⇧⌘M)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(theme.chrome)
        .overlay(alignment: .top) { Divider() }
    }

    private var selectionNoteComposer: some View {
        FileSelectionNoteComposer(
            selection: model.noteSelection,
            draft: $noteDraft,
            sending: model.noteSending,
            onCancel: {
                model.noteSelection = nil
                noteDraft = ""
            },
            onSend: {
                let note = noteDraft
                Task {
                    if await model.sendSelectionNote(note) {
                        noteDraft = ""
                        app.select(tab: .terminal, for: model.session.id)
                    }
                }
            }
        )
    }

    private var outlineList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Symbols")
                .font(.headline)
                .padding(12)
            Divider()
            if model.outline.isEmpty {
                ContentUnavailableView("No symbols", systemImage: "function")
            } else {
                List(model.outline) { symbol in
                    Button {
                        model.revealSymbol(symbol)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(symbol.name).font(.body.monospaced())
                            Text("\(symbol.kind)  ·  line \(symbol.line)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func markdownText(_ source: String) -> AttributedString {
        (try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .full)
        )) ?? AttributedString(source)
    }

    private func openExternal() {
        let path = externalPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return }
        showingExternalOpen = false
        Task { await model.openExternal(path) }
    }
}

private struct FileSelectionNoteComposer: View {
    @Environment(\.agentDockTheme) private var theme
    let selection: FileCodeSelection?
    @Binding var draft: String
    let sending: Bool
    let onCancel: () -> Void
    let onSend: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(selection?.lineLabel ?? "Selection")
                    .font(.caption.bold())
                if let selection {
                    Text(selection.text.components(separatedBy: "\n").prefix(6).joined(separator: "\n"))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
            }
            TextField("What should the agent change here?", text: $draft, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
            HStack {
                Text("The relative path, line range, language, and selected code are included.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: onSend) {
                    if sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Send to agent", systemImage: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(10)
        .background(theme.chrome)
        .overlay(alignment: .top) { Divider() }
        .onAppear { focused = true }
    }
}
