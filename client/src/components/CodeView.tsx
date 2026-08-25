import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { EditorState, Compartment, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { loadLanguage } from "../code-lang";
import "../styles/code-view.css";

export interface CodeViewHandle {
  /** Scroll `line` (1-based) into view and put the cursor there. */
  goToLine: (line: number) => void;
  focus: () => void;
}

interface Props {
  path: string;
  content: string;
  editable: boolean;
  onChange?: (next: string) => void;
  /** Every occurrence is marked; the one on `activeLine` is marked active. */
  highlightTerm?: string;
  activeLine?: number | null;
  onCmdClick?: (word: string, line: number) => void;
  onMatchCount?: (n: number) => void;
  /** The current selection, or null when it is empty. Line numbers are 1-based
   *  and inclusive, so they read the way the gutter does. */
  onSelectionChange?: (sel: { text: string; startLine: number; endLine: number } | null) => void;
}

/* Colours come from the theme variables, so the editor follows all nine
   AgentDock themes instead of shipping its own palette. */
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "var(--cm-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--cm-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--cm-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "var(--cm-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--cm-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--cm-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--cm-property)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--cm-punct)" },
  { tag: [t.definition(t.variableName), t.variableName], color: "var(--cm-text)" },
  { tag: [t.heading], color: "var(--cm-type)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--cm-function)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.invalid], color: "var(--cm-invalid)" },
]);

const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--cm-text)",
    backgroundColor: "var(--surface-0)",
    fontSize: "var(--cm-font-size)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "8px 0",
    caretColor: "var(--text-1)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55", overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "var(--surface-0)",
    color: "var(--text-4)",
    border: "none",
    borderRight: "1px solid var(--border-subtle)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)", color: "var(--text-2)" },
  ".cm-activeLine": { backgroundColor: "var(--surface-2)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-1)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--cm-selection)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--cm-selection-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--cm-find)", outline: "1px solid var(--cm-find-border)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--cm-find-active)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--surface-3)",
    outline: "1px solid var(--border-strong)",
  },
  ".cm-panels": { backgroundColor: "var(--surface-float)", color: "var(--text-2)" },
  ".cm-panels input, .cm-panels button": {
    backgroundColor: "var(--surface-2)",
    color: "var(--text-1)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--surface-3)",
    border: "none",
    color: "var(--text-3)",
  },
  ".cm-ad-hit": { backgroundColor: "var(--cm-find)", borderRadius: "2px" },
  ".cm-ad-hit-active": {
    backgroundColor: "var(--cm-find-active)",
    outline: "1px solid var(--cm-find-border)",
    borderRadius: "2px",
  },
});

/* ── Occurrence highlighting, driven from the search results ───────────── */

const setHits = StateEffect.define<{ term: string; activeLine: number | null }>();

function buildHits(state: EditorState, term: string, activeLine: number | null): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  if (!term) return b.finish();
  const needle = term.toLowerCase();
  const text = state.doc.toString().toLowerCase();
  let from = 0;
  let i: number;
  // Cap the decoration count: a one-character term in a large file would
  // otherwise create tens of thousands of ranges for no benefit.
  let made = 0;
  while ((i = text.indexOf(needle, from)) !== -1 && made < 5000) {
    const line = state.doc.lineAt(i).number;
    b.add(i, i + needle.length, line === activeLine ? activeMark : hitMark);
    from = i + needle.length;
    made++;
  }
  return b.finish();
}

const hitMark = Decoration.mark({ class: "cm-ad-hit" });
const activeMark = Decoration.mark({ class: "cm-ad-hit-active" });

const hitField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setHits)) return buildHits(tr.state, e.value.term, e.value.activeLine);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const WORD = /[A-Za-z0-9_$]/;

export const CodeView = forwardRef<CodeViewHandle, Props>(function CodeView(
  { path, content, editable, onChange, highlightTerm, activeLine, onCmdClick, onMatchCount, onSelectionChange },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langC = useRef(new Compartment());
  const editC = useRef(new Compartment());
  // Handlers change every render; read them through a ref so the editor is
  // never torn down and rebuilt just because a callback identity moved.
  const cb = useRef({ onChange, onCmdClick, onSelectionChange });
  cb.current = { onChange, onCmdClick, onSelectionChange };

  useImperativeHandle(ref, () => ({
    goToLine: (line: number) => {
      const v = view.current;
      if (!v) return;
      const n = Math.max(1, Math.min(line, v.state.doc.lines));
      const pos = v.state.doc.line(n).from;
      v.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    },
    focus: () => view.current?.focus(),
  }));

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        history(),
        bracketMatching(),
        indentOnInput(),
        highlightSelectionMatches(),
        syntaxHighlighting(highlightStyle, { fallback: true }),
        hitField,
        baseTheme,
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
        langC.current.of([]),
        editC.current.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
          if (!u.selectionSet && !u.docChanged) return;
          const report = cb.current.onSelectionChange;
          if (!report) return;
          const range = u.state.selection.main;
          if (range.empty) {
            report(null);
            return;
          }
          const doc = u.state.doc;
          /* Both ends get the same treatment: a drag that starts at the end of
             one line and stops at the start of another highlights neither, so
             reporting them would put lines the reader never marked into the
             note. Trim to the lines actually covered. */
          const startAt = doc.lineAt(range.from);
          const endAt = doc.lineAt(range.to);
          const startsAtLineEnd = startAt.to === range.from && endAt.number > startAt.number;
          const endsAtLineStart = endAt.from === range.to && endAt.number > startAt.number;
          const startLine = startsAtLineEnd ? startAt.number + 1 : startAt.number;
          const endLine = endsAtLineStart ? endAt.number - 1 : endAt.number;
          report({ text: u.state.sliceDoc(range.from, range.to), startLine, endLine });
        }),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            if (!(e.metaKey || e.ctrlKey)) return false;
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            const line = v.state.doc.lineAt(pos);
            const text = line.text;
            let a = pos - line.from;
            let b = a;
            if (a > 0 && (b >= text.length || !WORD.test(text[b])) && WORD.test(text[a - 1])) a--;
            if (!(a < text.length && WORD.test(text[a]))) return false;
            while (a > 0 && WORD.test(text[a - 1])) a--;
            while (b < text.length && WORD.test(text[b])) b++;
            const word = text.slice(a, b);
            if (!word || /^\d+$/.test(word)) return false;
            e.preventDefault();
            cb.current.onCmdClick?.(word, line.number);
            return true;
          },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // One editor per file. Content updates are dispatched, not remounted.
  }, [path]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    let alive = true;
    loadLanguage(path).then((lang) => {
      if (alive && view.current === v) {
        v.dispatch({ effects: langC.current.reconfigure(lang ? [lang] : []) });
      }
    });
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editC.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
    if (editable) view.current?.focus();
  }, [editable]);

  // Content pushed from outside (file reloaded, conflict resolved). Skip when
  // it already matches, or typing would fight the round-trip.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.state.doc.toString() === content) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } });
  }, [content]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: setHits.of({ term: highlightTerm ?? "", activeLine: activeLine ?? null }) });
    if (onMatchCount) {
      const term = (highlightTerm ?? "").toLowerCase();
      if (!term) onMatchCount(0);
      else {
        const hay = v.state.doc.toString().toLowerCase();
        let n = 0;
        let i = hay.indexOf(term);
        while (i !== -1) { n++; i = hay.indexOf(term, i + term.length); }
        onMatchCount(n);
      }
    }
  }, [highlightTerm, activeLine, content, onMatchCount]);

  return <div className="cm-host" ref={host} />;
});
