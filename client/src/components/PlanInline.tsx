import { memo } from "react";

/**
 * Inline markdown for a single block: code spans, bold, italic, links.
 *
 * A react-markdown instance per block would mean hundreds of parsers on a long
 * plan, and blocks re-render individually here. Plans are prose and checklists,
 * so this covers what they actually contain.
 */

type Tok = { t: "text" | "code" | "strong" | "em" | "link" | "strike"; s: string; href?: string };

const PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]*\]\([^)\s]+\))/;

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let rest = src;
  while (rest.length > 0) {
    const m = PATTERN.exec(rest);
    if (!m || m.index === undefined) {
      out.push({ t: "text", s: rest });
      break;
    }
    if (m.index > 0) out.push({ t: "text", s: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith("`")) out.push({ t: "code", s: tok.slice(1, -1) });
    else if (tok.startsWith("**") || tok.startsWith("__")) out.push({ t: "strong", s: tok.slice(2, -2) });
    else if (tok.startsWith("~~")) out.push({ t: "strike", s: tok.slice(2, -2) });
    else if (tok.startsWith("[")) {
      const cut = tok.indexOf("](");
      out.push({ t: "link", s: tok.slice(1, cut), href: tok.slice(cut + 2, -1) });
    } else out.push({ t: "em", s: tok.slice(1, -1) });
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export const PlanInline = memo(function PlanInline({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((tok, i) => {
        switch (tok.t) {
          case "code":
            return <code key={i} className="pv-code">{tok.s}</code>;
          case "strong":
            return <strong key={i}>{tok.s}</strong>;
          case "em":
            return <em key={i}>{tok.s}</em>;
          case "strike":
            return <s key={i}>{tok.s}</s>;
          case "link":
            return (
              <a key={i} href={tok.href} target="_blank" rel="noreferrer noopener" className="pv-link">
                {tok.s}
              </a>
            );
          default:
            return <span key={i}>{tok.s}</span>;
        }
      })}
    </>
  );
});
