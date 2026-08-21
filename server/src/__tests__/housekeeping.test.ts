/**
 * Tests for housekeeping.ts — the parsing that decides what gets offered up
 * for removal, and the rule that keeps an active session's branch off that
 * list.
 *
 * Pure logic: no git, no filesystem.
 */

import { describe, test, expect } from "bun:test";
import {
  parseWorktreeList,
  parseDuKilobytes,
  parseRefLines,
  classifyBranches,
  isSessionBranch,
} from "../services/housekeeping";

describe("parseWorktreeList", () => {
  test("reads the ordinary shape: main tree first, then linked worktrees", () => {
    const out = [
      "worktree /Users/v/projects/chat",
      "HEAD 8f2c1d0e5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d",
      "branch refs/heads/main",
      "",
      "worktree /Users/v/projects/.worktrees/mod-flags/chat",
      "HEAD 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      "branch refs/heads/wt-3f9a",
      "",
    ].join("\n");

    const wts = parseWorktreeList(out);
    expect(wts.length).toBe(2);
    expect(wts[0].path).toBe("/Users/v/projects/chat");
    expect(wts[0].branch).toBe("main");
    expect(wts[0].head).toBe("8f2c1d0e5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d");
    expect(wts[1].branch).toBe("wt-3f9a");
    expect(wts[1].detached).toBe(false);
    expect(wts[1].bare).toBe(false);
  });

  test("does not emit a record for the trailing blank line", () => {
    const out = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\n";
    expect(parseWorktreeList(out).length).toBe(1);
  });

  test("keeps spaces in a path", () => {
    const out = "worktree /Users/v/My Projects/chat wt\nHEAD abc\nbranch refs/heads/wt-1\n";
    expect(parseWorktreeList(out)[0].path).toBe("/Users/v/My Projects/chat wt");
  });

  test("records a detached worktree with no branch", () => {
    const out = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /repo-wt",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "detached",
      "",
    ].join("\n");

    const [, det] = parseWorktreeList(out);
    expect(det.detached).toBe(true);
    expect(det.branch).toBeUndefined();
    expect(det.head).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  test("records a worktree whose directory is gone", () => {
    const out = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /repo-wt-deleted",
      "HEAD bbb",
      "branch refs/heads/wt-dead",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");

    const gone = parseWorktreeList(out)[1];
    expect(gone.prunable).toBe(true);
    expect(gone.prunableReason).toBe("gitdir file points to non-existent location");
    expect(gone.branch).toBe("wt-dead");
  });

  test("accepts locked and prunable with or without a reason", () => {
    const out = [
      "worktree /a",
      "HEAD aaa",
      "branch refs/heads/wt-a",
      "locked",
      "",
      "worktree /b",
      "HEAD bbb",
      "branch refs/heads/wt-b",
      "locked on a removable device",
      "prunable",
      "",
    ].join("\n");

    const [a, b] = parseWorktreeList(out);
    expect(a.locked).toBe(true);
    expect(a.lockedReason).toBeUndefined();
    expect(b.locked).toBe(true);
    expect(b.lockedReason).toBe("on a removable device");
    expect(b.prunable).toBe(true);
    expect(b.prunableReason).toBeUndefined();
  });

  test("a bare record carries no HEAD line", () => {
    const out = "worktree /repo.git\nbare\n\nworktree /repo-wt\nHEAD abc\nbranch refs/heads/wt-1\n";
    const [bare, linked] = parseWorktreeList(out);
    expect(bare.bare).toBe(true);
    expect(bare.head).toBeUndefined();
    expect(bare.branch).toBeUndefined();
    expect(linked.branch).toBe("wt-1");
  });

  test("says nothing about empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n\n")).toEqual([]);
  });

  test("ignores fields that arrive before any worktree line", () => {
    expect(parseWorktreeList("HEAD abc\nbranch refs/heads/main\n")).toEqual([]);
  });

  test("survives CRLF line endings", () => {
    const out = "worktree /repo\r\nHEAD abc\r\nbranch refs/heads/wt-1\r\n";
    expect(parseWorktreeList(out)[0].branch).toBe("wt-1");
  });
});

describe("isSessionBranch", () => {
  test("recognises branches a session made", () => {
    expect(isSessionBranch("wt-3f9a")).toBe(true);
    expect(isSessionBranch("wt-mod-412")).toBe(true);
  });

  test("leaves human branches alone", () => {
    for (const b of ["main", "master", "feature/wt-thing", "want-this", "redesign/cockpit"]) {
      expect(isSessionBranch(b)).toBe(false);
    }
  });
});

describe("classifyBranches", () => {
  test("stale means merged and not checked out anywhere", () => {
    const { stale, unmerged, inUse } = classifyBranches(
      ["wt-a", "wt-b", "wt-c"],
      ["wt-a", "wt-b", "main"],
      ["wt-b"],
    );
    expect(stale).toEqual(["wt-a"]);
    expect(unmerged).toEqual(["wt-c"]);
    expect(inUse).toEqual(["wt-b"]);
  });

  test("a live worktree's branch is never stale, however merged it looks", () => {
    const { stale, inUse } = classifyBranches(["wt-live"], ["wt-live"], ["wt-live"]);
    expect(stale).toEqual([]);
    expect(inUse).toEqual(["wt-live"]);
  });

  test("nothing is stale when nothing is merged", () => {
    const { stale, unmerged } = classifyBranches(["wt-a", "wt-b"], [], []);
    expect(stale).toEqual([]);
    expect(unmerged).toEqual(["wt-a", "wt-b"]);
  });

  test("handles empty input", () => {
    expect(classifyBranches([], [], [])).toEqual({ stale: [], unmerged: [], inUse: [] });
  });
});

describe("parseDuKilobytes", () => {
  test("reads the first field as kilobytes", () => {
    expect(parseDuKilobytes("7340032\t/Users/v/wt\n")).toBe(7340032 * 1024);
    expect(parseDuKilobytes("  512 /path\n")).toBe(512 * 1024);
  });

  test("reports -1 when there is no number to read", () => {
    expect(parseDuKilobytes("")).toBe(-1);
    expect(parseDuKilobytes("du: /gone: No such file or directory\n")).toBe(-1);
  });
});

describe("parseRefLines", () => {
  test("drops blanks and the detached HEAD placeholder", () => {
    expect(parseRefLines("main\nwt-a\n\nHEAD\nwt-b\n")).toEqual(["main", "wt-a", "wt-b"]);
  });

  test("handles empty input", () => {
    expect(parseRefLines("")).toEqual([]);
  });
});
