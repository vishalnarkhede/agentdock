import SwiftUI

private enum CreateTaskSource: String, CaseIterable, Identifiable {
    case blank
    case ticket
    case chat

    var id: String { rawValue }
    var title: String {
        switch self {
        case .blank: "Write it"
        case .ticket: "Linear ticket"
        case .chat: "Just talk"
        }
    }
}

struct CreateSessionView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var selected: Set<String> = []
    @State private var name = ""
    @State private var prompt = ""
    @State private var agent = "claude"
    @State private var isolated = true
    @State private var grouped = true
    @State private var skipPermissions = false
    @State private var creating = false
    @State private var appliedDefaults = false
    @State private var source: CreateTaskSource = .blank
    @State private var ticketDraft = ""
    @State private var templates: [SessionTemplate] = []
    @State private var templateName = ""
    @State private var savingTemplate = false
    @State private var meta: [String: String] = [:]
    private let api = APIClient()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("New session")
                .font(.title.bold())

            if !templates.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(templates) { template in
                            HStack(spacing: 0) {
                                Button {
                                    apply(template)
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(template.name).fontWeight(.medium)
                                        Text(template.targets.isEmpty ? "no repositories" : template.targets.joined(separator: ", "))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                }
                                .buttonStyle(.plain)
                                Button {
                                    delete(template)
                                } label: {
                                    Image(systemName: "xmark")
                                        .font(.caption)
                                }
                                .buttonStyle(.borderless)
                                .padding(.trailing, 8)
                            }
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }

            HSplitView {
                List(model.repositories, selection: $selected) { repo in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(repo.alias).fontWeight(.medium)
                        Text(repo.path)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .tag(repo.alias)
                }
                .frame(minWidth: 220)

                Form {
                    TextField("Session name (optional)", text: $name)

                    Picker("Task source", selection: $source) {
                        ForEach(CreateTaskSource.allCases) { source in
                            Text(source.title).tag(source)
                        }
                    }
                    .pickerStyle(.segmented)

                    if source == .ticket {
                        TextField("Linear ticket ID or URL", text: $ticketDraft)
                            .font(.body.monospaced())
                        if !ticketDraft.isEmpty {
                            Text(NativeTicket.parseID(ticketDraft).map { "Will add \($0) to the agent brief." }
                                ?? "Enter an ID such as MOD-412 or paste its Linear URL.")
                                .font(.caption)
                                .foregroundStyle(NativeTicket.parseID(ticketDraft) == nil ? .red : .secondary)
                        }
                    }

                    Picker("Agent", selection: $agent) {
                        Text("Claude").tag("claude")
                        Text("Cursor").tag("cursor")
                    }
                    .pickerStyle(.segmented)

                    Toggle("Create isolated worktree", isOn: $isolated)
                    Toggle("Group repositories into one session", isOn: $grouped)
                        .disabled(selected.count < 2)
                    Toggle("Skip permission prompts", isOn: $skipPermissions)

                    if !model.settings.metaProperties.isEmpty {
                        Section("Session properties") {
                            ForEach(model.settings.metaProperties) { preset in
                                if preset.values.isEmpty {
                                    TextField(preset.label, text: metaBinding(preset.key))
                                } else {
                                    Picker(preset.label, selection: metaBinding(preset.key)) {
                                        Text("None").tag("")
                                        ForEach(preset.values, id: \.self) { Text($0).tag($0) }
                                    }
                                }
                            }
                        }
                    }

                    Text("Initial prompt")
                        .font(.headline)
                    TextEditor(text: $prompt)
                        .font(.body)
                        .frame(minHeight: 170)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                }
                .formStyle(.grouped)
                .frame(minWidth: 440)
            }

            HStack {
                Text(selected.isEmpty
                    ? (source == .chat ? "A conversation without a repository." : "Select at least one repository.")
                    : "\(selected.count) repositor\(selected.count == 1 ? "y" : "ies") selected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                TextField("Template name", text: $templateName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 170)
                Button("Save Template") {
                    saveTemplate()
                }
                .disabled(templateName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || savingTemplate)
                Button("Cancel") { dismiss() }
                Button {
                    create()
                } label: {
                    if creating {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Create Session")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled((selected.isEmpty && source != .chat) || creating)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(minWidth: 760, minHeight: 570)
        .task {
            guard !appliedDefaults else { return }
            appliedDefaults = true
            agent = model.settings.preferences.defaultAgent
            skipPermissions = model.settings.preferences.defaultSkipPermissions
            templates = (try? await api.fetchTemplates()) ?? []
        }
    }

    private func create() {
        creating = true
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if source == .ticket, let ticket = NativeTicket.parseID(ticketDraft) {
            let ticketLine = NativeTicket.promptLine(for: ticket)
            cleanPrompt = cleanPrompt.isEmpty ? ticketLine : "\(ticketLine)\n\n\(cleanPrompt)"
        }
        let orderedTargets = source == .chat
            ? []
            : model.repositories.map(\.alias).filter(selected.contains)
        let payload = CreateSessionPayload(
            targets: orderedTargets,
            name: cleanName.isEmpty ? nil : cleanName,
            prompt: cleanPrompt.isEmpty ? nil : cleanPrompt,
            grouped: selected.count > 1 ? grouped : false,
            isolated: isolated,
            dangerouslySkipPermissions: skipPermissions,
            agentType: agent,
            meta: cleanMeta
        )
        Task {
            if await model.createSession(payload) {
                dismiss()
            }
            creating = false
        }
    }

    private var cleanMeta: [String: String]? {
        let values = meta.reduce(into: [String: String]()) { result, item in
            let value = item.value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { result[item.key] = value }
        }
        return values.isEmpty ? nil : values
    }

    private func metaBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { meta[key] ?? "" },
            set: { meta[key] = $0 }
        )
    }

    private func apply(_ template: SessionTemplate) {
        selected = Set(template.targets)
        prompt = template.prompt ?? ""
        isolated = template.isolated ?? false
        grouped = template.grouped ?? true
        meta = template.meta ?? [:]
    }

    private func saveTemplate() {
        let cleanName = templateName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { return }
        savingTemplate = true
        let targets = model.repositories.map(\.alias).filter(selected.contains)
        let template = NewSessionTemplate(
            name: cleanName,
            targets: targets,
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
            isolated: isolated,
            grouped: grouped,
            meta: cleanMeta
        )
        Task {
            do {
                templates.append(try await api.saveTemplate(template))
                templateName = ""
            } catch {
                model.errorMessage = error.localizedDescription
            }
            savingTemplate = false
        }
    }

    private func delete(_ template: SessionTemplate) {
        templates.removeAll { $0.id == template.id }
        Task {
            do {
                try await api.deleteTemplate(template.id)
            } catch {
                templates.append(template)
                model.errorMessage = error.localizedDescription
            }
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
