import AppKit
import SwiftUI

struct NativeTextEditor: NSViewRepresentable {
    @Binding var text: String
    var editable: Bool
    var selection: NSRange?
    var onSelectionChange: ((NSRange) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder

        let editor = NSTextView()
        editor.delegate = context.coordinator
        editor.isRichText = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.allowsUndo = true
        editor.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        editor.textContainerInset = NSSize(width: 10, height: 10)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = true
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = false
        editor.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        editor.string = text
        editor.isEditable = editable
        scroll.documentView = editor
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        editor.isEditable = editable
        if editor.string != text {
            editor.string = text
        }
        if let selection, editor.selectedRange() != selection,
           selection.location + selection.length <= editor.string.utf16.count {
            editor.setSelectedRange(selection)
            editor.scrollRangeToVisible(selection)
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeTextEditor

        init(parent: NativeTextEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = editor.string
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.onSelectionChange?(editor.selectedRange())
        }
    }
}
