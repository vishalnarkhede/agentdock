/**
 * Tests for worktrees.ts — parsing what git reports, and matching it to owners.
 *
 * Pure parsing; nothing here runs git.
 */

import { describe, expect, it } from "bun:test";
import { dedupeByPath, ownersByPath, parseWorktreeList } from "../services/worktrees";

const REAL = `worktree /Users/vishal/projects/chat
HEAD d89b0827c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6
branch refs/heads/chore/mod2-1284

worktree /Users/vishal/.cursor/worktrees/chat/orf
HEAD ab5cd4e3b81122334455667788990011aabbccdd
detached

worktree /Users/vishal/projects/.worktrees/wt-1e402b/chat
HEAD 0dde07c82a99887766554433221100ffeeddccbb
branch refs/heads/fix/mod2-1291-analyze-pop-failover
`;

describe("parseWorktreeList", () => {
  it("reads every record, in order", () => {
    const out = parseWorktreeList(REAL);
    expect(out.map((w) => w.path)).toEqual([
      "/Users/vishal/projects/chat",
      "/Users/vishal/.cursor/worktrees/chat/orf",
      "/Users/vishal/projects/.worktrees/wt-1e402b/chat",
    ]);
  });

  it("strips refs/heads/ from the branch", () => {
    expect(parseWorktreeList(REAL)[0].branch).toBe("chore/mod2-1284");
  });

  it("keeps a branch name that contains slashes intact", () => {
    expect(parseWorktreeList(REAL)[2].branch).toBe("fix/mod2-1291-analyze-pop-failover");
  });

  it("reports a detached HEAD as no branch rather than guessing", () => {
    expect(parseWorktreeList(REAL)[1].branch).toBeNull();
  });

  it("shortens the head sha", () => {
    expect(parseWorktreeList(REAL)[0].head).toBe("d89b0827c1");
  });

  it("flags a prunable worktree", () => {
    const out = parseWorktreeList(
      "worktree /gone\nHEAD abc123\nprunable gitdir file points to non-existent location\n",
    );
    expect(out[0].prunable).toBe(true);
  });

  it("does not flag a healthy worktree as prunable", () => {
    expect(parseWorktreeList(REAL).every((w) => !w.prunable)).toBe(true);
  });

  it("handles output with no trailing blank line", () => {
    expect(parseWorktreeList("worktree /a\nHEAD abc\nbranch refs/heads/x")).toHaveLength(1);
  });

  it("returns nothing for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("ownersByPath", () => {
  it("maps every worktree of every session", () => {
    const owners = ownersByPath({
      "claude-a": [
        { repoPath: "/repo/one", wtDir: "/wt/a-one" },
        { repoPath: "/repo/two", wtDir: "/wt/a-two" },
      ],
      "claude-b": [{ repoPath: "/repo/one", wtDir: "/wt/b-one" }],
    });
    expect(owners.get("/wt/a-two")).toBe("claude-a");
    expect(owners.get("/wt/b-one")).toBe("claude-b");
    expect(owners.size).toBe(3);
  });

  it("has nothing to say about a worktree no session claims", () => {
    expect(ownersByPath({}).get("/wt/orphan")).toBeUndefined();
  });
});

describe("dedupeByPath", () => {
  it("keeps one entry per path, the first", () => {
    const out = dedupeByPath([
      { path: "/a", repo: "one" },
      { path: "/b", repo: "one" },
      { path: "/a", repo: "two" },
    ]);
    expect(out).toEqual([
      { path: "/a", repo: "one" },
      { path: "/b", repo: "one" },
    ]);
  });

  it("leaves a list that is already unique alone", () => {
    const list = [{ path: "/a" }, { path: "/b" }];
    expect(dedupeByPath(list)).toEqual(list);
  });

  it("handles an empty list", () => {
    expect(dedupeByPath([])).toEqual([]);
  });
});
