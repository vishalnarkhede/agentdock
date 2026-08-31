import AppKit
import CodeEditLanguages
import CodeEditSourceEditor
import SwiftUI

/// Syntax colors stay Xcode-like; canvas colors come from the AgentDock theme.
enum AgentDockEditorTheme {
    static func resolved(_ theme: AgentDockTheme) -> EditorTheme {
        theme.isLight ? light(theme) : dark(theme)
    }

    private static func dark(_ theme: AgentDockTheme) -> EditorTheme {
        EditorTheme(
            text: .init(color: NSColor(theme.textBright)),
            insertionPoint: NSColor(theme.accent),
            invisibles: .init(color: NSColor(theme.textDim)),
            background: NSColor(theme.background),
            lineHighlight: NSColor(theme.hover),
            selection: NSColor(theme.input),
            keywords: .init(color: NSColor(srgbRed: 1, green: 0.48, blue: 0.70, alpha: 1), bold: true),
            commands: .init(color: NSColor(srgbRed: 0.47, green: 0.76, blue: 0.70, alpha: 1)),
            types: .init(color: NSColor(srgbRed: 0.42, green: 0.87, blue: 1, alpha: 1)),
            attributes: .init(color: NSColor(srgbRed: 0.80, green: 0.59, blue: 0.41, alpha: 1)),
            variables: .init(color: NSColor(srgbRed: 0.31, green: 0.69, blue: 0.80, alpha: 1)),
            values: .init(color: NSColor(srgbRed: 0.70, green: 0.51, blue: 0.92, alpha: 1)),
            numbers: .init(color: NSColor(srgbRed: 0.85, green: 0.79, blue: 0.49, alpha: 1)),
            strings: .init(color: NSColor(srgbRed: 1, green: 0.51, blue: 0.44, alpha: 1)),
            characters: .init(color: NSColor(srgbRed: 0.85, green: 0.79, blue: 0.49, alpha: 1)),
            comments: .init(color: NSColor(theme.textDim))
        )
    }

    private static func light(_ theme: AgentDockTheme) -> EditorTheme {
        EditorTheme(
            text: .init(color: NSColor(theme.textBright)),
            insertionPoint: NSColor(theme.accent),
            invisibles: .init(color: NSColor(theme.textDim)),
            background: NSColor(theme.background),
            lineHighlight: NSColor(theme.hover),
            selection: NSColor(theme.input),
            keywords: .init(color: NSColor(srgbRed: 0.67, green: 0.05, blue: 0.57, alpha: 1), bold: true),
            commands: .init(color: NSColor(srgbRed: 0.15, green: 0.47, blue: 0.40, alpha: 1)),
            types: .init(color: NSColor(srgbRed: 0.04, green: 0.43, blue: 0.64, alpha: 1)),
            attributes: .init(color: NSColor(srgbRed: 0.55, green: 0.35, blue: 0.14, alpha: 1)),
            variables: .init(color: NSColor(srgbRed: 0.11, green: 0.38, blue: 0.52, alpha: 1)),
            values: .init(color: NSColor(srgbRed: 0.42, green: 0.20, blue: 0.65, alpha: 1)),
            numbers: .init(color: NSColor(srgbRed: 0.42, green: 0.35, blue: 0.05, alpha: 1)),
            strings: .init(color: NSColor(srgbRed: 0.77, green: 0.10, blue: 0.09, alpha: 1)),
            characters: .init(color: NSColor(srgbRed: 0.42, green: 0.35, blue: 0.05, alpha: 1)),
            comments: .init(color: NSColor(theme.textDim))
        )
    }
}

enum EditorLanguage {
    static func detect(path: String, contents: String) -> CodeLanguage {
        CodeLanguage.detectLanguageFrom(
            url: URL(fileURLWithPath: path),
            prefixBuffer: String(contents.prefix(400)),
            suffixBuffer: String(contents.suffix(400))
        )
    }
}

/// Turns AgentDock's symbol index into CodeEdit's Cmd-click jump targets.
final class JumpToDefinitionBridge: JumpToDefinitionDelegate {
    weak var model: NativeFileExplorerModel?

    func queryLinks(forRange range: NSRange, textView: TextViewController) async -> [JumpToDefinitionLink]? {
        // A language server wants a position, not a name, and both LSP and
        // NSString count characters in UTF-16 — so the offset needs no
        // translation, only splitting into line and column.
        let probe: (name: String, line: Int, col: Int)? = await MainActor.run {
            guard let view = textView.textView, let storage = view.textStorage else { return nil }
            let length = storage.length
            guard length > 0 else { return nil }
            let anchor = range.location == NSNotFound ? 0 : min(max(0, range.location), length)
            let start = max(0, anchor - 128)
            let end = min(length, anchor + max(range.length, 0) + 128)
            let window = NSRange(location: start, length: end - start)
            let text = storage.attributedSubstring(from: window).string as NSString
            let local = NSRange(
                location: anchor - start,
                length: min(max(range.length, 0), window.length - (anchor - start))
            )
            guard let name = Identifier.at(local, in: text) else { return nil }
            guard let position = view.layoutManager.textLineForOffset(anchor) else { return nil }
            return (name, position.index + 1, anchor - position.range.location + 1)
        }
        guard let probe, let model else { return nil }
        return await model.definitionLinks(name: probe.name, line: probe.line, col: probe.col)
    }

    func openLink(link: JumpToDefinitionLink) {
        Task { @MainActor in
            let line = max(link.targetRange.start.line, 1)
            if let url = link.url, url.isFileURL {
                await model?.open(url.path, line: line)
            } else if let path = model?.document?.path {
                await model?.open(path, line: line)
            }
        }
    }
}

enum Identifier {
    static func at(_ range: NSRange, in text: NSString) -> String? {
        guard text.length > 0 else { return nil }
        var start = min(max(0, range.location), text.length)
        if range.location == NSNotFound { start = 0 }
        var end = min(max(start, range.location + max(range.length, 0)), text.length)
        while start > 0, isIdent(text.character(at: start - 1)) { start -= 1 }
        while end < text.length, isIdent(text.character(at: end)) { end += 1 }
        guard end > start else { return nil }
        let value = text.substring(with: NSRange(location: start, length: end - start))
        return value.range(of: #"^[A-Za-z_$][\w$]*$"#, options: .regularExpression) != nil ? value : nil
    }

    private static func isIdent(_ scalar: unichar) -> Bool {
        (scalar >= 48 && scalar <= 57)
            || (scalar >= 65 && scalar <= 90)
            || (scalar >= 97 && scalar <= 122)
            || scalar == 95
            || scalar == 36
    }
}

struct NativeCodeEditor: View {
    @Environment(\.agentDockTheme) private var theme
    @Environment(\.agentDockChrome) private var chrome
    @Binding var text: String
    let storage: NSTextStorage?
    let path: String
    let editable: Bool
    @Binding var state: SourceEditorState
    let jumpBridge: JumpToDefinitionBridge?
    let editorBridge: NativeEditorBridge?
    let epoch: Int

    init(
        text: Binding<String>,
        path: String,
        editable: Bool,
        state: Binding<SourceEditorState>,
        jumpBridge: JumpToDefinitionBridge?,
        editorBridge: NativeEditorBridge?,
        epoch: Int
    ) {
        _text = text
        storage = nil
        self.path = path
        self.editable = editable
        _state = state
        self.jumpBridge = jumpBridge
        self.editorBridge = editorBridge
        self.epoch = epoch
    }

    init(
        storage: NSTextStorage,
        path: String,
        editable: Bool,
        state: Binding<SourceEditorState>,
        jumpBridge: JumpToDefinitionBridge?,
        editorBridge: NativeEditorBridge?,
        epoch: Int
    ) {
        _text = .constant("")
        self.storage = storage
        self.path = path
        self.editable = editable
        _state = state
        self.jumpBridge = jumpBridge
        self.editorBridge = editorBridge
        self.epoch = epoch
    }

    var body: some View {
        editor
        // CodeEdit 0.15 does not apply a changed storage object to an existing
        // controller. Recreate only when a different document is installed;
        // same-file jumps stay on the live NativeEditorBridge.
        .id("\(path)#\(epoch)#\(theme.id)#\(chrome.id)")
    }

    @ViewBuilder
    private var editor: some View {
        if let storage {
            SourceEditor(
                storage,
                language: EditorLanguage.detect(path: path, contents: storage.string),
                configuration: configuration,
                state: $state,
                coordinators: [editorBridge].compactMap { $0 },
                jumpToDefinitionDelegate: jumpBridge
            )
        } else {
            SourceEditor(
                $text,
                language: EditorLanguage.detect(path: path, contents: text),
                configuration: configuration,
                state: $state,
                coordinators: [editorBridge].compactMap { $0 },
                jumpToDefinitionDelegate: jumpBridge
            )
        }
    }

    private var configuration: SourceEditorConfiguration {
        // Match VS Code's large-file posture: keep editing and highlighting,
        // but skip duplicate document renderers that scale with every line.
        let largeDocument = (storage?.length ?? (text as NSString).length) > 200_000
        return SourceEditorConfiguration(
            appearance: .init(
                theme: AgentDockEditorTheme.resolved(theme),
                font: .monospacedSystemFont(ofSize: chrome.mono, weight: .regular),
                wrapLines: false
            ),
            behavior: .init(isEditable: editable),
            peripherals: .init(
                showGutter: true,
                showMinimap: !largeDocument,
                showFoldingRibbon: !largeDocument
            )
        )
    }
}
