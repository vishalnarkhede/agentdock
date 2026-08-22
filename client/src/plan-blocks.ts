/**
 * Split a plan into addressable blocks.
 *
 * Must agree with planBlocks() on the server, since comment anchors are keyed
 * by the ids produced here.
 */

export interface PlanBlock {
  id: string;
  text: string;
  kind: "heading" | "list" | "code" | "quote" | "rule" | "table" | "para";
  level: number;
  /** Checkbox state for list items, or null when the item has no checkbox. */
  checked: boolean | null;
  /** Line index in the source, for raw-mode mapping. */
  line: number;
}

export function normalize(s: string): string {
  return s
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX~/-]\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** FNV-1a, hex. Matches nothing on the server byte-for-byte; see blockId(). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The server hashes with sha1 and the client cannot cheaply match that, so the
 * client sends the normalized anchor text and lets the server mint the id.
 * This local id is only for React keys and in-page addressing.
 */
export function localBlockId(text: string, occurrence: number): string {
  const base = fnv1a(normalize(text));
  return occurrence > 0 ? `${base}:${occurrence}` : base;
}

export function parsePlan(plan: string): PlanBlock[] {
  const out: PlanBlock[] = [];
  const seen = new Map<string, number>();
  const lines = plan.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const text = raw.trim();

    if (/^(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (!text) continue;

    let kind: PlanBlock["kind"] = "para";
    let level = 0;
    let checked: boolean | null = null;

    if (inFence) {
      kind = "code";
    } else if (/^#{1,6}\s/.test(text)) {
      kind = "heading";
      level = (text.match(/^#+/) ?? ["#"])[0].length;
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
      kind = "rule";
    } else if (/^>/.test(text)) {
      kind = "quote";
    } else if (/^\|/.test(text)) {
      kind = "table";
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(raw)) {
      kind = "list";
      level = Math.floor((raw.length - raw.trimStart().length) / 2);
      const box = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX~/-])\]/.exec(raw);
      if (box) checked = box[1].toLowerCase() === "x";
    }

    const key = normalize(text);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);

    out.push({ id: localBlockId(text, n), text, kind, level, checked, line: i });
  }

  return out;
}

export interface PlanProgress {
  done: number;
  total: number;
}

export function planProgress(blocks: PlanBlock[]): PlanProgress {
  let done = 0;
  let total = 0;
  for (const b of blocks) {
    if (b.checked === null) continue;
    total++;
    if (b.checked) done++;
  }
  return { done, total };
}

/** Headings, for the section jump list. */
export function planOutline(blocks: PlanBlock[]): PlanBlock[] {
  return blocks.filter((b) => b.kind === "heading" && b.level <= 3);
}
