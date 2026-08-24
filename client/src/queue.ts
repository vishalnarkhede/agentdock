import type { SessionInfo } from "./types";

/**
 * The queue is ordered by what an item costs you, not by name or recency.
 *
 * Blocked agents cost the most: nothing moves until you answer. Reviewable
 * work costs the next most: the agent is done but the change cannot ship.
 * Working and idle cost nothing right now.
 *
 * Ordering *within* a bucket is left to the caller, which preserves the
 * settle-stable recency order — so a row never moves because of a sort, only
 * because its actual cost to you changed.
 */
export type QueueBucket = "blocked" | "review" | "working" | "idle" | "stale";

export const QUEUE_BUCKETS: { id: QueueBucket; label: string; cost: string }[] = [
  { id: "blocked", label: "Waiting on you", cost: "blocks the agent" },
  { id: "review", label: "Ready to review", cost: "blocks the merge" },
  { id: "working", label: "Working", cost: "nothing to do" },
  { id: "idle", label: "Idle", cost: "nothing to do" },
  { id: "stale", label: "Stale", cost: "dropped out of the queue" },
];

/** Buckets that are worth interrupting someone for. */
export const NOTIFY_BUCKETS: QueueBucket[] = ["blocked", "review"];

export function queueBucket(session: SessionInfo): QueueBucket {
  if (session.status === "stopped") return "stale";
  const line = session.statusLine?.type;
  // An explicit question or a failure is the only thing that truly blocks.
  if (line === "input" || line === "error") return "blocked";
  if (session.status === "working" || session.status === "background") return "working";
  // Finished its turn: there is something to look at.
  if (line === "done" || session.status === "waiting") return "review";
  return "idle";
}

export function bucketMeta(id: QueueBucket) {
  return QUEUE_BUCKETS.find((b) => b.id === id);
}

/**
 * Splits queue rows into the sections a grouping asks for, keeping the order
 * the grouping put them in and the caller's order inside each section.
 *
 * Returns null when there is no grouping to apply, so the caller can render a
 * flat list. A row whose section is not in `order` gets a section of its own at
 * the end rather than disappearing.
 */
export function queueSections<T extends { section?: string }>(
  rows: T[],
  order: string[] | undefined,
): { label: string; rows: T[] }[] | null {
  if (!order || order.length === 0) return null;
  const byLabel = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.section) continue;
    const list = byLabel.get(r.section);
    if (list) list.push(r);
    else byLabel.set(r.section, [r]);
  }
  const out = order
    .filter((label) => byLabel.has(label))
    .map((label) => ({ label, rows: byLabel.get(label) as T[] }));
  for (const [label, list] of byLabel) {
    if (!out.some((s) => s.label === label)) out.push({ label, rows: list });
  }
  return out.length > 0 ? out : null;
}
