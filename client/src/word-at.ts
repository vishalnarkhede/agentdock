/**
 * The identifier under a point in rendered, syntax-highlighted code.
 *
 * highlight.js splits identifiers across elements, so a match has to be
 * assembled from the neighbouring text nodes rather than read off one of them.
 */

const WORD = /[A-Za-z0-9_$]/;

export function expandWord(text: string, offset: number): { word: string; start: number; end: number } | null {
  if (offset < 0 || offset > text.length) return null;
  let start = offset;
  let end = offset;
  // A click just past the last character should still select that identifier.
  if (start > 0 && (end >= text.length || !WORD.test(text[end])) && WORD.test(text[start - 1])) {
    start--;
    end = start + 1;
  }
  if (end > start ? !WORD.test(text[start]) : true) {
    if (!(start < text.length && WORD.test(text[start]))) return null;
  }
  while (start > 0 && WORD.test(text[start - 1])) start--;
  while (end < text.length && WORD.test(text[end])) end++;
  const word = text.slice(start, end);
  if (!word || /^\d+$/.test(word)) return null;
  return { word, start, end };
}

/**
 * Walk outward from `node` across sibling text so an identifier broken into
 * several spans still reads as one word.
 */
export interface WordHit {
  word: string;
  /** 1-based line within `root`, so callers know where the click landed. */
  line: number;
}

/** Newlines in `root` before (node, offset) — the line the click is on. */
function lineOf(node: Text, offset: number, root: Element): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Text | null;
  let line = 1;
  while ((n = walker.nextNode() as Text | null)) {
    const t = n.textContent ?? "";
    if (n === node) {
      for (let i = 0; i < Math.min(offset, t.length); i++) {
        if (t.charCodeAt(i) === 10) line++;
      }
      return line;
    }
    for (let i = 0; i < t.length; i++) {
      if (t.charCodeAt(i) === 10) line++;
    }
  }
  return line;
}

export function wordFromNode(node: Node, offset: number, root: Element): string | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Text | null;
  while ((n = walker.nextNode() as Text | null)) nodes.push(n);

  const idx = nodes.indexOf(node as Text);
  if (idx === -1) return null;

  let text = "";
  let cursor = offset;
  // Two neighbours either side is plenty for a split identifier and keeps this
  // cheap on a large file.
  const from = Math.max(0, idx - 2);
  for (let i = from; i < idx; i++) {
    text += nodes[i].textContent ?? "";
    cursor += (nodes[i].textContent ?? "").length;
  }
  text += node.textContent ?? "";
  for (let i = idx + 1; i <= Math.min(nodes.length - 1, idx + 2); i++) {
    text += nodes[i].textContent ?? "";
  }

  const hit = expandWord(text, cursor);
  return hit?.word ?? null;
}

export function wordAtPoint(x: number, y: number, root: Element): WordHit | null {
  const doc = document as any;
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  }
  if (!node || !root.contains(node)) return null;
  const word = wordFromNode(node, offset, root);
  if (!word) return null;
  return { word, line: lineOf(node as Text, offset, root) };
}
