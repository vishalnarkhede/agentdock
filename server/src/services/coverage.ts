/**
 * Plan-to-diff coverage.
 *
 * AgentDock already stores the plan an agent wrote and can already read the
 * diff it produced. Nothing connected the two. Connecting them answers a
 * question neither the compiler nor the test suite can: did it change things
 * the task never asked for, and did it skip things the task did ask for?
 *
 * Both halves matter. A diff can be perfectly idiomatic and still be doing
 * something nobody wanted, and a plan step can sit unchecked while the run
 * reports success.
 */

export type StepState = "covered" | "gap" | "investigated";

export interface PlanStep {
  index: number;
  text: string;
  done: boolean;
  files: string[];
  state: StepState;
}

export interface ChangedFile {
  path: string;
  plus: number;
  minus: number;
  /** Index of the plan step this file is attributable to, or null. */
  step: number | null;
}

export interface Coverage {
  steps: PlanStep[];
  files: ChangedFile[];
  stats: {
    filesTotal: number;
    filesMapped: number;
    filesUnplanned: number;
    stepsTotal: number;
    stepsCovered: number;
    stepsGap: number;
    linesChanged: number;
  };
  /** True once the diff is large enough that review quality falls off. */
  oversized: boolean;
}

/** Above roughly this many changed lines, human review stops being effective. */
export const REVIEW_LINE_THRESHOLD = 400;

/** Steps phrased as investigation are not expected to produce code. */
const RESEARCH_VERBS =
  /^(read|trace|check|investigate|look|find|understand|review|audit|explore|inspect|measure|confirm|verify|compare|identify|reproduce|diagnose|profile|search)\b/i;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "into", "from", "that", "this", "when", "then",
  "add", "use", "using", "make", "run", "set", "get", "new", "old", "all",
  "its", "it's", "their", "should", "would", "could", "must", "need", "needs",
  "plan", "step", "code", "file", "files", "test", "tests", "fix", "update",
  "change", "changes", "so", "not", "but", "any", "one", "two", "per", "via",
  "does", "done", "also", "only", "than", "them", "they", "have", "has",
]);

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

/** Tokens from a file path that a plan step might plausibly name. */
function fileTokens(path: string): string[] {
  const segs = path.split("/").filter(Boolean);
  const base = segs[segs.length - 1] ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  const toks = new Set<string>();
  toks.add(path.toLowerCase());
  toks.add(base.toLowerCase());
  if (stem) toks.add(stem.toLowerCase());
  for (const s of segs.slice(0, -1)) if (s.length >= 3) toks.add(s.toLowerCase());
  // snake_case / kebab-case sub-words of the stem
  for (const part of stem.split(/[._-]/)) {
    if (part.length >= 4 && !STOP_WORDS.has(part.toLowerCase())) toks.add(part.toLowerCase());
  }
  return [...toks];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-token match only. Plain substring matching is wrong here: a step
 * reading "describe_table for moderation_flags" contains the substring
 * "moderation", which would silently claim every file under moderation/.
 * `\b` treats `_` as a word character, which is exactly what we want —
 * "flags" must not match inside "moderation_flags".
 */
function mentions(hay: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(hay);
}

/**
 * Score how strongly a step's text refers to a file. Longer, more specific
 * matches win, so "flags/writer.go" beats a bare mention of "flags".
 */
function score(stepText: string, path: string): number {
  const hay = stepText.toLowerCase();
  let best = 0;
  for (const tok of fileTokens(path)) {
    if (tok.length < 4) continue;
    if (!mentions(hay, tok)) continue;
    // A full path or filename match is worth far more than a directory word.
    const weight = tok.includes("/") ? tok.length * 3 : tok.includes(".") ? tok.length * 2 : tok.length;
    if (weight > best) best = weight;
  }
  return best;
}

export function buildCoverage(
  markdown: string | null,
  changed: { path: string; plus: number; minus: number }[],
): Coverage {
  const parsed = markdown ? parsePlanSteps(markdown) : [];
  const steps: PlanStep[] = parsed.map((p, i) => ({
    index: i,
    text: p.text,
    done: p.done,
    files: [],
    state: "gap",
  }));

  const files: ChangedFile[] = changed.map((f) => ({ ...f, step: null }));

  for (const file of files) {
    let bestIdx: number | null = null;
    let bestScore = 0;
    for (const step of steps) {
      const sc = score(step.text, file.path);
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = step.index;
      }
    }
    if (bestIdx !== null) {
      file.step = bestIdx;
      steps[bestIdx].files.push(file.path);
    }
  }

  for (const step of steps) {
    if (step.files.length > 0) step.state = "covered";
    else if (RESEARCH_VERBS.test(step.text)) step.state = "investigated";
    else step.state = "gap";
  }

  const linesChanged = files.reduce((n, f) => n + f.plus + f.minus, 0);
  const filesMapped = files.filter((f) => f.step !== null).length;

  return {
    steps,
    files,
    stats: {
      filesTotal: files.length,
      filesMapped,
      filesUnplanned: files.length - filesMapped,
      stepsTotal: steps.length,
      stepsCovered: steps.filter((s) => s.state === "covered").length,
      stepsGap: steps.filter((s) => s.state === "gap").length,
      linesChanged,
    },
    oversized: linesChanged > REVIEW_LINE_THRESHOLD,
  };
}
