/**
 * Which sessions are about to collide.
 *
 * This was half of triage.ts. The other half scored the *shape* of a diff for a
 * Triage tab and planned merge order for a Ship tab, and both of those surfaces
 * are gone. Detecting the collision is what was worth keeping: two worktrees
 * editing the same file is the standard failure of running agents in parallel,
 * and it is invisible until the second merge.
 */

export interface Conflict {
  /** Session display names that both touch these files. */
  sessions: [string, string];
  files: string[];
}

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
