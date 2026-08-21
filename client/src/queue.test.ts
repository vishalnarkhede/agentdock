import { describe, test, expect } from "bun:test";
import { queueBucket, QUEUE_BUCKETS, bucketMeta, type QueueBucket } from "./queue";
import type { SessionInfo } from "./types";

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    name: "claude-x",
    displayName: "x",
    status: "waiting",
    worktrees: [],
    ...over,
  } as SessionInfo;
}

describe("queueBucket", () => {
  test("an open question blocks, whatever the status says", () => {
    expect(queueBucket(session({ status: "working", statusLine: { type: "input", message: "?" } }))).toBe("blocked");
  });

  test("an error blocks too — it also needs a human", () => {
    expect(queueBucket(session({ status: "waiting", statusLine: { type: "error", message: "boom" } }))).toBe("blocked");
  });

  test("working and background agents cost nothing right now", () => {
    expect(queueBucket(session({ status: "working" }))).toBe("working");
    expect(queueBucket(session({ status: "background" }))).toBe("working");
  });

  test("a finished turn is reviewable", () => {
    expect(queueBucket(session({ status: "waiting" }))).toBe("review");
    expect(queueBucket(session({ status: "shell", statusLine: { type: "done", message: "ok" } }))).toBe("review");
  });

  test("a shell with nothing to say is idle, not reviewable", () => {
    expect(queueBucket(session({ status: "shell" }))).toBe("idle");
  });

  test("stopped sessions leave the queue", () => {
    expect(queueBucket(session({ status: "stopped" }))).toBe("stale");
  });

  test("every bucket the mapper can return has display metadata", () => {
    const ids = QUEUE_BUCKETS.map((b) => b.id);
    const all: QueueBucket[] = ["blocked", "review", "working", "idle", "stale"];
    for (const id of all) {
      expect(ids).toContain(id);
      expect(bucketMeta(id)?.cost).toBeTruthy();
    }
  });
});

import { isQuietHour } from "./hooks/useQueueNotifications";

describe("isQuietHour", () => {
  test("a range inside one day", () => {
    expect(isQuietHour(13, 12, 14)).toBe(true);
    expect(isQuietHour(12, 12, 14)).toBe(true);   // start is inclusive
    expect(isQuietHour(14, 12, 14)).toBe(false);  // end is exclusive
    expect(isQuietHour(9, 12, 14)).toBe(false);
  });

  test("a range that wraps midnight — the case that is easy to get wrong", () => {
    expect(isQuietHour(22, 21, 8)).toBe(true);
    expect(isQuietHour(3, 21, 8)).toBe(true);
    expect(isQuietHour(21, 21, 8)).toBe(true);
    expect(isQuietHour(8, 21, 8)).toBe(false);
    expect(isQuietHour(12, 21, 8)).toBe(false);
  });

  test("an empty range never suppresses anything", () => {
    for (const h of [0, 6, 12, 23]) expect(isQuietHour(h, 9, 9)).toBe(false);
  });
});
