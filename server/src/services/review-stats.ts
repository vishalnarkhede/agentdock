/**
 * The two things a review surface counts: what the plan asked for, and what the
 * diff did.
 *
 * These used to live in coverage.ts alongside the machinery that guessed which
 * plan step a changed file belonged to. That guess was the Coverage tab, and it
 * is gone; the counting is not, because the Plan and Changes surfaces put it in
 * their headers.
 */

/** Parse markdown checklist lines into steps. Everything else is prose. */
export function parsePlanSteps(markdown: string): { text: string; done: boolean }[] {
  const out: { text: string; done: boolean }[] = [];
  for (const raw of markdown.split("\n")) {
    const m = raw.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!m) continue;
    const text = m[2]
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*([^*]*)\*\*/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .trim();
    if (!text) continue;
    out.push({ done: m[1].toLowerCase() === "x", text });
  }
  return out;
}

/** Parse `git diff --numstat` output. Binary files report as 0/0. */
export function parseNumstat(stdout: string): { path: string; plus: number; minus: number }[] {
  const out: { path: string; plus: number; minus: number }[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    let path = rest.join("\t");
    // Rename form: "old => new" or "dir/{old => new}/file"
    const brace = path.match(/^(.*)\{[^}]*=>\s*([^}]*)\}(.*)$/);
    if (brace) path = (brace[1] + brace[2] + brace[3]).replace(/\/\//g, "/");
    else if (path.includes(" => ")) path = path.split(" => ").pop()!.trim();
    if (!path) continue;
    out.push({
      path,
      plus: a === "-" ? 0 : parseInt(a, 10) || 0,
      minus: d === "-" ? 0 : parseInt(d, 10) || 0,
    });
  }
  return out;
}
