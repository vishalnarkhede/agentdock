/**
 * Wrap query matches in already-highlighted HTML.
 *
 * The previous approach injected <mark> elements into the DOM after render.
 * React owns that subtree through dangerouslySetInnerHTML and re-applies the
 * whole string on the next commit, which silently deleted every mark — the
 * marks were built correctly and then wiped a few milliseconds later. Baking
 * them into the HTML React renders removes the race entirely.
 *
 * Works on a plain-text projection of the HTML so that matches are found
 * across syntax-highlighting spans: highlight.js routinely splits an
 * identifier into several elements, and matching inside a single text node
 * misses those.
 */

interface Run {
  /** Offsets into the text projection. */
  textStart: number;
  textEnd: number;
  /** Offsets into the source HTML. */
  htmlStart: number;
  htmlEnd: number;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

interface Projection {
  text: string;
  runs: Run[];
  /** html offset for the start of each text character. */
  htmlAt: number[];
  /** html offset just past each text character. */
  htmlEndAt: number[];
}

export function project(html: string): Projection {
  const runs: Run[] = [];
  const htmlAt: number[] = [];
  const htmlEndAt: number[] = [];
  let text = "";
  let i = 0;
  let run: Run | null = null;

  const closeRun = () => {
    if (run) {
      run.textEnd = text.length;
      runs.push(run);
      run = null;
    }
  };

  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      closeRun();
      const gt = html.indexOf(">", i);
      i = gt === -1 ? html.length : gt + 1;
      continue;
    }
    if (!run) run = { textStart: text.length, textEnd: text.length, htmlStart: i, htmlEnd: i };

    let consumed = 1;
    let out = ch;
    if (ch === "&") {
      const semi = html.indexOf(";", i);
      if (semi !== -1 && semi - i <= 8) {
        const ent = html.slice(i, semi + 1);
        const dec = ENTITIES[ent];
        if (dec !== undefined) {
          out = dec;
          consumed = ent.length;
        }
      }
    }
    htmlAt.push(i);
    htmlEndAt.push(i + consumed);
    text += out;
    i += consumed;
    run.htmlEnd = i;
  }
  closeRun();

  return { text, runs, htmlAt, htmlEndAt };
}

export interface MarkResult {
  html: string;
  /** 1-based line number of each match, in document order. */
  lines: number[];
  count: number;
}

/**
 * `activeIndex` gets an extra class so the current match is visually distinct.
 * A match that straddles a tag boundary is wrapped once per run, so the HTML
 * stays well-formed.
 */
export function markHtml(html: string, query: string, activeIndex = -1): MarkResult {
  if (!query) return { html, lines: [], count: 0 };
  const { text, runs, htmlAt, htmlEndAt } = project(html);
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return { html, lines: [], count: 0 };

  const matches: { start: number; end: number }[] = [];
  let from = 0;
  let at: number;
  while ((at = hay.indexOf(needle, from)) !== -1) {
    matches.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  if (matches.length === 0) return { html, lines: [], count: 0 };

  // Line numbers, from the projection so they match the file's own numbering.
  const lines: number[] = [];
  let cursor = 0;
  let line = 1;
  for (const m of matches) {
    while (cursor < m.start) {
      if (text.charCodeAt(cursor) === 10) line++;
      cursor++;
    }
    lines.push(line);
  }

  // Build (htmlStart, htmlEnd, matchIndex) segments, clipped to runs.
  const segs: { s: number; e: number; idx: number }[] = [];
  for (let mi = 0; mi < matches.length; mi++) {
    const m = matches[mi];
    for (const r of runs) {
      if (r.textEnd <= m.start || r.textStart >= m.end) continue;
      const s = Math.max(m.start, r.textStart);
      const e = Math.min(m.end, r.textEnd);
      if (s >= e) continue;
      segs.push({ s: htmlAt[s], e: htmlEndAt[e - 1], idx: mi });
    }
  }

  segs.sort((a, b) => b.s - a.s);
  let out = html;
  for (const seg of segs) {
    const cls = seg.idx === activeIndex ? "fe-match fe-match-active" : "fe-match";
    const open = `<mark class="${cls}" data-match="${seg.idx}" data-line="${lines[seg.idx]}">`;
    out = out.slice(0, seg.s) + open + out.slice(seg.s, seg.e) + "</mark>" + out.slice(seg.e);
  }

  return { html: out, lines, count: matches.length };
}
