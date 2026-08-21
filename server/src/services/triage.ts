/**
 * Review triage.
 *
 * Two questions a reviewer asks before reading a single line of diff: is this
 * change small enough that reading it will work, and is there anything about
 * its *shape* that deserves attention regardless of whether the code is good.
 *
 * Every signal here is derived from the file list alone — no commands are run
 * and nothing is inferred about correctness. A signal is a reason to look, not
 * a verdict.
 */

export type Severity = "warn" | "info";

export interface Signal {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  files?: string[];
}

export interface Conflict {
  /** Session display names that both touch these files. */
  sessions: [string, string];
  files: string[];
}

/** Above roughly this many changed lines, human review stops being effective. */
export const REVIEW_LINE_THRESHOLD = 400;
/** A single file this large dominates the pass regardless of the total. */
export const SINGLE_FILE_THRESHOLD = 300;

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.[a-z]+$/i;
const MIGRATION_PATH = /(^|\/)migrations?\//i;
const SQL_PATH = /\.sql$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/i;
const CONFIG_PATH = /(^|\/)(\.env(\.|$)|config\/|feature_flags?\.(ya?ml|json)|settings\.(ya?ml|json))/i;
const GENERATED = /(^|\/)(dist|build|node_modules|vendor|\.next|coverage)\//i;

export function isTestFile(path: string): boolean {
  return TEST_PATH.test(path);
}

export interface TriageInput {
  files: { path: string; plus: number; minus: number; step?: number | null }[];
  /** True when a plan exists with at least one checklist item. */
  hasPlanSteps?: boolean;
}

export function detectSignals(input: TriageInput): Signal[] {
  const files = input.files.filter((f) => !GENERATED.test(f.path));
  const out: Signal[] = [];
  if (files.length === 0) return out;

  const lines = files.reduce((n, f) => n + f.plus + f.minus, 0);
  if (lines > REVIEW_LINE_THRESHOLD) {
    out.push({
      id: "oversized",
      severity: "warn",
      title: `${lines} changed lines is past the point where review works`,
      detail:
        "Attention drops sharply above roughly " +
        REVIEW_LINE_THRESHOLD +
        " changed lines. Splitting this into more than one pass costs less than missing something.",
    });
  }

  const big = files.filter((f) => f.plus + f.minus > SINGLE_FILE_THRESHOLD);
  if (big.length > 0) {
    out.push({
      id: "single-large-file",
      severity: "info",
      title: big.length === 1 ? "One file carries most of the change" : `${big.length} files are very large`,
      detail: "A file this size dominates the pass. Read it first, while attention is cheapest.",
      files: big.map((f) => f.path),
    });
  }

  const tests = files.filter((f) => isTestFile(f.path));
  const source = files.filter((f) => !isTestFile(f.path) && !LOCKFILE.test(f.path));
  if (tests.length === 0 && source.length > 0) {
    out.push({
      id: "no-tests",
      severity: "warn",
      title: "No test file changed anywhere in this diff",
      detail: `${source.length} source file${source.length === 1 ? "" : "s"} changed and nothing was added to cover them.`,
    });
  }

  const migrations = files.filter((f) => MIGRATION_PATH.test(f.path) || SQL_PATH.test(f.path));
  if (migrations.length > 0) {
    out.push({
      id: "migration",
      severity: "warn",
      title: migrations.length === 1 ? "A migration is in this change" : `${migrations.length} migrations are in this change`,
      detail: "Schema changes are the hardest thing here to undo once it ships. Check it separately from the code.",
      files: migrations.map((f) => f.path),
    });
  }

  const config = files.filter((f) => CONFIG_PATH.test(f.path));
  if (config.length > 0) {
    out.push({
      id: "config",
      severity: "info",
      title: "Configuration changed alongside code",
      detail: "Config often needs a matching change in another repo or a deploy step to take effect.",
      files: config.map((f) => f.path),
    });
  }

  const locks = files.filter((f) => LOCKFILE.test(f.path));
  if (locks.length > 0) {
    out.push({
      id: "lockfile",
      severity: "info",
      title: "A dependency lockfile changed",
      detail: "Dependencies moved. Worth knowing whether that was intended or incidental.",
      files: locks.map((f) => f.path),
    });
  }

  if (input.hasPlanSteps) {
    const unplanned = files.filter((f) => f.step === null || f.step === undefined);
    if (unplanned.length > 0) {
      out.push({
        id: "unplanned",
        severity: "warn",
        title: `${unplanned.length} file${unplanned.length === 1 ? "" : "s"} the plan never mentions`,
        detail: "Not necessarily wrong. Not asked for either. The compiler and the tests both pass on work nobody wanted.",
        files: unplanned.map((f) => f.path),
      });
    }
  }

  return out;
}

/**
 * Which sessions are about to collide.
 *
 * Two worktrees editing the same file is the standard failure of running
 * agents in parallel, and it is invisible until the second merge. Surfacing it
 * before either merge is the whole point.
 */
export function findConflicts(
  worktrees: { session: string; files: string[] }[],
): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < worktrees.length; i++) {
    for (let j = i + 1; j < worktrees.length; j++) {
      const a = worktrees[i];
      const b = worktrees[j];
      if (a.session === b.session) continue;
      const bSet = new Set(b.files);
      const shared = a.files.filter((f) => bSet.has(f)).sort();
      if (shared.length > 0) {
        out.push({ sessions: [a.session, b.session], files: shared });
      }
    }
  }
  // Most-entangled pairs first — that is the merge you want to think about.
  return out.sort((x, y) => y.files.length - x.files.length);
}

/**
 * Everything a branch would bring to a merge: its committed work plus whatever
 * is still uncommitted, de-duplicated.
 *
 * Using only `git diff HEAD` is the trap here — a session that has already
 * committed reports nothing, and those are exactly the sessions closest to
 * merging and most likely to collide.
 */
export function unionPaths(...lists: string[][]): string[] {
  const seen = new Set<string>();
  for (const list of lists) for (const p of list) if (p) seen.add(p);
  return [...seen].sort();
}

// ─── Ship: planning the merge, not performing it ───

export type MergeStrategy = "serial" | "integration";

export interface ShipItem {
  session: string;
  branch: string;
  target: string;
  /** Files this branch would bring, for conflict attribution. */
  files: string[];
}

export interface MergeStep {
  kind: "merge" | "test" | "resolve" | "branch" | "cleanup";
  text: string;
  note?: string;
}

/**
 * The order to merge in, and why.
 *
 * Serial is the default because each merge then sees the one before it, so a
 * conflict surfaces on its own instead of all at once — and a failing test
 * stops the queue with everything after it untouched. An integration branch is
 * offered for the case where enough branches touch each other that resolving
 * the same conflict N times stops being reasonable.
 *
 * Pure: this plans, it does not run git. Nothing here mutates a repository.
 */
export function planMergeOrder(
  items: ShipItem[],
  strategy: MergeStrategy,
  conflicts: Conflict[] = [],
): MergeStep[] {
  if (items.length === 0) return [];

  const entangled = new Set<string>();
  for (const c of conflicts) {
    for (const s of c.sessions) entangled.add(s);
  }

  if (strategy === "integration") {
    const steps: MergeStep[] = [
      { kind: "branch", text: `Create an integration branch from ${items[0].target}` },
    ];
    for (const it of items) {
      steps.push({ kind: "merge", text: `Merge ${it.branch}`, note: it.session });
    }
    steps.push({
      kind: "resolve",
      text: "Resolve conflicts on the integration branch",
      note: `one pass instead of ${items.length}`,
    });
    steps.push({ kind: "test", text: "Run the repo test command" });
    steps.push({
      kind: "merge",
      text: `Merge the integration branch into ${items[0].target}`,
      note: "a single commit lands",
    });
    return steps;
  }

  // Serial: least-entangled first, so the branch that has to resolve is the one
  // with the most context about the others.
  const ordered = [...items].sort((a, b) => {
    const ea = entangled.has(a.session) ? 1 : 0;
    const eb = entangled.has(b.session) ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return a.files.length - b.files.length;
  });

  const steps: MergeStep[] = [];
  let seenEntangled = false;
  for (const it of ordered) {
    const isEntangled = entangled.has(it.session);
    steps.push({
      kind: "merge",
      text: `Merge ${it.branch} into ${it.target}`,
      note: isEntangled && seenEntangled ? "this is where the shared file has to be resolved" : it.session,
    });
    if (isEntangled) seenEntangled = true;
    steps.push({
      kind: "test",
      text: "Run the repo test command",
      note: "a failure stops the queue; nothing after it runs",
    });
  }
  steps.push({ kind: "cleanup", text: `Remove ${ordered.length} merged worktree${ordered.length === 1 ? "" : "s"}` });
  return steps;
}
