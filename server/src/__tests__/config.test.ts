/**
 * Tests for config.ts — file-based configuration CRUD.
 *
 * Uses a temp directory (set by test-preload.ts) to avoid touching real config files.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as config from "../services/config";

// AGENTDOCK_CONFIG_DIR was set to a temp dir by test-preload.ts before config.ts loaded
const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR!;
const SESSIONS_DIR = join(CONFIG_DIR, "sessions");

beforeEach(() => {
  // Clean and recreate the temp config dir before each test
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(join(CONFIG_DIR, "..", ".."), { recursive: true, force: true });
});

// ─── Plans ───

describe("getPlan", () => {
  const PLANS_DIR = join(CONFIG_DIR, "plans");

  test("returns the plan filed under the agent's own key", () => {
    mkdirSync(PLANS_DIR, { recursive: true });
    writeFileSync(join(PLANS_DIR, "external-44.md"), "# Pane plan\n");

    expect(config.getPlan("external-44")).toBe("# Pane plan\n");
  });

  test("returns null when this agent has no plan, even if others do", () => {
    // The old fallback returned the most recently modified plan in the directory.
    // Once the directory holds one plan per agent that means confidently showing
    // someone else's — worse than showing nothing.
    mkdirSync(PLANS_DIR, { recursive: true });
    writeFileSync(join(PLANS_DIR, "external-44.md"), "# Someone else's plan\n");

    expect(config.getPlan("claude-mine")).toBeNull();
  });

  test("returns null when no plans exist at all", () => {
    expect(config.getPlan("claude-mine")).toBeNull();
  });
});

// ─── Hook registration ───

describe("syncHooksToClaudeSettings", () => {
  // HOME is a temp dir courtesy of test-preload, so this writes to a throwaway
  // settings.json rather than the real one.
  const SETTINGS = join(process.env.HOME!, ".claude", "settings.json");
  const readSettings = () => JSON.parse(readFileSync(SETTINGS, "utf-8"));

  test("registers the plan hook on PostToolUse for Write and Edit", () => {
    config.syncHooksToClaudeSettings();
    const entry = readSettings().hooks.PostToolUse.find((h: any) =>
      h.hooks?.some((hh: any) => hh.command?.includes("plan-hook.sh")),
    );

    expect(entry).toBeDefined();
    expect(entry.matcher).toBe("Write|Edit");
    // Synchronous by design — async failure handling is undocumented, and a plan
    // that copies unreliably is worse than no plan at all.
    expect(entry.hooks[0].async).toBeUndefined();
  });

  test("installs the plan hook script as executable next to the plans dir", () => {
    config.syncHooksToClaudeSettings();
    // The script locates the plans dir relative to itself, so this layout is load-bearing.
    expect(existsSync(join(CONFIG_DIR, "hooks", "plan-hook.sh"))).toBe(true);
  });

  test("does not register a second copy when run again", () => {
    // Runs on every server start, and the settings file is the user's own.
    config.syncHooksToClaudeSettings();
    config.syncHooksToClaudeSettings();
    config.syncHooksToClaudeSettings();

    const planHooks = readSettings().hooks.PostToolUse.filter((h: any) =>
      h.hooks?.some((hh: any) => hh.command?.includes("plan-hook.sh")),
    );
    expect(planHooks).toHaveLength(1);
  });

  test("leaves hooks it does not own alone", () => {
    mkdirSync(join(process.env.HOME!, ".claude"), { recursive: true });
    writeFileSync(SETTINGS, JSON.stringify({
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "workmux set-window-status working" }] }] },
    }));

    config.syncHooksToClaudeSettings();

    const commands = readSettings().hooks.PostToolUse.flatMap((h: any) =>
      h.hooks.map((hh: any) => hh.command),
    );
    expect(commands).toContain("workmux set-window-status working");
    expect(commands.some((c: string) => c.includes("plan-hook.sh"))).toBe(true);
  });
});

// ─── Preferences ───

describe("Preferences", () => {
  test("getPreferences returns empty object when no file exists", () => {
    const prefs = config.getPreferences();
    expect(prefs).toEqual({});
  });

  test("savePreferences and getPreferences round-trip", () => {
    const prefs = {
      theme: "dark",
      fontSize: "14px",
      cursorBlink: true,
      scrollback: 5000,
      notificationsEnabled: true,
    };
    config.savePreferences(prefs);
    const loaded = config.getPreferences();
    expect(loaded).toEqual(prefs);
  });

  test("savePreferences overwrites previous preferences", () => {
    config.savePreferences({ theme: "dark" });
    config.savePreferences({ theme: "light", fontSize: "16px" });
    const loaded = config.getPreferences();
    expect(loaded.theme).toBe("light");
    expect(loaded.fontSize).toBe("16px");
  });

  test("getPreferences returns empty object for corrupt JSON", () => {
    writeFileSync(join(CONFIG_DIR, "preferences.json"), "not json{{{");
    const prefs = config.getPreferences();
    expect(prefs).toEqual({});
  });
});

// ─── Meta Property Presets ───

describe("MetaPropertyPresets", () => {
  test("getMetaPropertyPresets returns empty array when no file", () => {
    expect(config.getMetaPropertyPresets()).toEqual([]);
  });

  test("saveMetaPropertyPresets and getMetaPropertyPresets round-trip", () => {
    const presets = [
      { key: "priority", label: "Priority", values: ["low", "medium", "high"] },
      { key: "team", label: "Team", values: ["frontend", "backend"] },
    ];
    config.saveMetaPropertyPresets(presets);
    expect(config.getMetaPropertyPresets()).toEqual(presets);
  });

  test("getMetaPropertyPresets returns empty array for corrupt JSON", () => {
    writeFileSync(join(CONFIG_DIR, "meta-properties.json"), "broken");
    expect(config.getMetaPropertyPresets()).toEqual([]);
  });

  test("getMetaPropertyPresets returns empty array for non-array JSON", () => {
    writeFileSync(join(CONFIG_DIR, "meta-properties.json"), '{"key": "val"}');
    expect(config.getMetaPropertyPresets()).toEqual([]);
  });
});

// ─── Session Properties ───

describe("SessionProperties", () => {
  test("getSessionProperties returns empty object when no file", () => {
    expect(config.getSessionProperties("test-session")).toEqual({});
  });

  test("saveSessionProperties and getSessionProperties round-trip", () => {
    const meta = { priority: "high", team: "backend", ticket: "MOD-123" };
    config.saveSessionProperties("test-session", meta);
    expect(config.getSessionProperties("test-session")).toEqual(meta);
  });

  test("deleteSessionProperties removes the file", () => {
    config.saveSessionProperties("test-session", { key: "val" });
    config.deleteSessionProperties("test-session");
    expect(config.getSessionProperties("test-session")).toEqual({});
  });

  test("getSessionProperties returns empty object for corrupt file", () => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(join(SESSIONS_DIR, "test-session.meta"), "not json");
    expect(config.getSessionProperties("test-session")).toEqual({});
  });
});

// ─── Session Agent Type ───

describe("SessionAgentType", () => {
  test("getSessionAgentType returns null when no file", () => {
    expect(config.getSessionAgentType("test-session")).toBeNull();
  });

  test("saveSessionAgentType and getSessionAgentType round-trip", () => {
    config.saveSessionAgentType("test-session", "claude");
    expect(config.getSessionAgentType("test-session")).toBe("claude");
  });

  test("deleteSessionAgentType removes the file", () => {
    config.saveSessionAgentType("test-session", "claude");
    config.deleteSessionAgentType("test-session");
    expect(config.getSessionAgentType("test-session")).toBeNull();
  });
});

// ─── Session Skip Permissions ───

describe("SessionSkipPerms", () => {
  test("getSessionSkipPerms returns false when no file", () => {
    expect(config.getSessionSkipPerms("test-session")).toBe(false);
  });

  test("saveSessionSkipPerms true creates the marker file", () => {
    config.saveSessionSkipPerms("test-session", true);
    expect(config.getSessionSkipPerms("test-session")).toBe(true);
  });

  test("saveSessionSkipPerms false removes the marker file", () => {
    config.saveSessionSkipPerms("test-session", true);
    config.saveSessionSkipPerms("test-session", false);
    expect(config.getSessionSkipPerms("test-session")).toBe(false);
  });

  test("deleteSessionSkipPerms removes the file", () => {
    config.saveSessionSkipPerms("test-session", true);
    config.deleteSessionSkipPerms("test-session");
    expect(config.getSessionSkipPerms("test-session")).toBe(false);
  });
});

// ─── Session Type ───

describe("SessionType", () => {
  test("getSessionType returns null when no file", () => {
    expect(config.getSessionType("test-session")).toBeNull();
  });

  test("saveSessionType and getSessionType round-trip", () => {
    config.saveSessionType("test-session", "ticket");
    expect(config.getSessionType("test-session")).toBe("ticket");
  });

  test("deleteSessionType removes the file", () => {
    config.saveSessionType("test-session", "ticket");
    config.deleteSessionType("test-session");
    expect(config.getSessionType("test-session")).toBeNull();
  });
});

// ─── Session Parent/Children ───

describe("SessionParentChildren", () => {
  test("getSessionParent returns null when no file", () => {
    expect(config.getSessionParent("child-session")).toBeNull();
  });

  test("saveSessionParent and getSessionParent round-trip", () => {
    config.saveSessionParent("child-session", "parent-session");
    expect(config.getSessionParent("child-session")).toBe("parent-session");
  });

  test("getSessionChildren returns children", () => {
    config.saveSessionParent("child-1", "parent-session");
    config.saveSessionParent("child-2", "parent-session");
    const children = config.getSessionChildren("parent-session");
    expect(children).toContain("child-1");
    expect(children).toContain("child-2");
    expect(children).toHaveLength(2);
  });

  test("getSessionChildren returns empty array when no children", () => {
    expect(config.getSessionChildren("lonely-session")).toEqual([]);
  });

  test("deleteSessionParent removes the file", () => {
    config.saveSessionParent("child-session", "parent-session");
    config.deleteSessionParent("child-session");
    expect(config.getSessionParent("child-session")).toBeNull();
  });

  test("getNextChildIndex returns 1 when no children", () => {
    expect(config.getNextChildIndex("parent-session")).toBe(1);
  });

  test("getNextChildIndex increments based on existing sub-N suffixes", () => {
    config.saveSessionParent("parent-session-sub-1", "parent-session");
    config.saveSessionParent("parent-session-sub-3", "parent-session");
    // Should return max(1,3) + 1 = 4
    expect(config.getNextChildIndex("parent-session")).toBe(4);
  });
});

// ─── Session Order ───

describe("SessionOrder", () => {
  test("getSessionOrder returns empty array when no file", () => {
    expect(config.getSessionOrder()).toEqual([]);
  });

  test("saveSessionOrder and getSessionOrder round-trip", () => {
    const order = ["session-a", "session-b", "session-c"];
    config.saveSessionOrder(order);
    expect(config.getSessionOrder()).toEqual(order);
  });
});

// ─── Repos ───

describe("Repos", () => {
  test("getRepos returns empty array when no file", () => {
    expect(config.getRepos()).toEqual([]);
  });

  test("addRepo and getRepos round-trip", () => {
    config.addRepo({ alias: "chat", path: "/Users/test/chat" });
    const repos = config.getRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].alias).toBe("chat");
  });

  test("addRepo updates existing repo with same alias", () => {
    config.addRepo({ alias: "chat", path: "/old/path" });
    config.addRepo({ alias: "chat", path: "/new/path" });
    const repos = config.getRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].path).toBe("/new/path");
  });

  test("removeRepo removes by alias", () => {
    config.addRepo({ alias: "chat", path: "/path/chat" });
    config.addRepo({ alias: "django", path: "/path/django" });
    config.removeRepo("chat");
    const repos = config.getRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].alias).toBe("django");
  });

  test("resolveAlias finds repo by alias", () => {
    config.addRepo({ alias: "myrepo", path: "/test/myrepo" });
    const found = config.resolveAlias("myrepo");
    expect(found).toBeDefined();
    expect(found!.path).toBe("/test/myrepo");
  });

  test("resolveAlias returns undefined for unknown alias", () => {
    expect(config.resolveAlias("nonexistent")).toBeUndefined();
  });
});

// ─── Custom Actions ───

describe("CustomActions", () => {
  test("getCustomActions returns empty array when no file", () => {
    expect(config.getCustomActions()).toEqual([]);
  });

  test("saveCustomAction creates action with generated ID", () => {
    const action = config.saveCustomAction({
      label: "Deploy",
      hint: "Deploy to staging",
      prompt: "Deploy the current branch to staging",
    });
    expect(action.id).toMatch(/^custom-/);
    expect(action.label).toBe("Deploy");
  });

  test("saveCustomAction appends to existing actions", () => {
    config.saveCustomAction({ label: "Action 1", hint: "h1", prompt: "p1" });
    config.saveCustomAction({ label: "Action 2", hint: "h2", prompt: "p2" });
    const actions = config.getCustomActions();
    expect(actions).toHaveLength(2);
  });

  test("deleteCustomAction removes by ID", () => {
    const action = config.saveCustomAction({ label: "Test", hint: "h", prompt: "p" });
    config.deleteCustomAction(action.id);
    expect(config.getCustomActions()).toHaveLength(0);
  });
});

// ─── Session Meta (worktree meta) ───

describe("SessionMeta", () => {
  test("getSessionMeta returns empty array when no file", () => {
    expect(config.getSessionMeta("test-session")).toEqual([]);
  });

  test("saveWorktreeMeta and getSessionMeta round-trip", () => {
    config.saveWorktreeMeta("test-session", "/repo/path", "/worktree/dir");
    const metas = config.getSessionMeta("test-session");
    expect(metas).toHaveLength(1);
    expect(metas[0]).toEqual({ repoPath: "/repo/path", wtDir: "/worktree/dir" });
  });

  test("saveWorktreeMeta appends multiple entries", () => {
    config.saveWorktreeMeta("test-session", "/repo/a", "/wt/a");
    config.saveWorktreeMeta("test-session", "/repo/b", "/wt/b");
    const metas = config.getSessionMeta("test-session");
    expect(metas).toHaveLength(2);
  });

  test("saveWorktreeMeta can mark Agentdock-managed worktrees", () => {
    config.saveWorktreeMeta("test-session", "/repo/path", "/worktree/dir", true);
    const metas = config.getSessionMeta("test-session");
    expect(metas[0]).toEqual({ repoPath: "/repo/path", wtDir: "/worktree/dir", managed: true });
  });

  test("deleteSessionMeta removes the file", () => {
    config.saveWorktreeMeta("test-session", "/repo", "/wt");
    config.deleteSessionMeta("test-session");
    expect(config.getSessionMeta("test-session")).toEqual([]);
  });
});

// ─── DB Shards ───

describe("DbShards", () => {
  test("getDbShards returns empty array when no file", () => {
    expect(config.getDbShards()).toEqual([]);
  });

  test("addDbShard and getDbShards round-trip", () => {
    const shard = {
      name: "us-east:c1",
      host: "db.example.com",
      port: 5432,
      database: "chat",
      user: "admin",
      password: "secret",
    };
    config.addDbShard(shard);
    const shards = config.getDbShards();
    expect(shards).toHaveLength(1);
    expect(shards[0].name).toBe("us-east:c1");
  });

  test("addDbShard updates existing shard by name", () => {
    config.addDbShard({ name: "s1", host: "old", port: 5432, database: "db", user: "u", password: "p" });
    config.addDbShard({ name: "s1", host: "new", port: 5432, database: "db", user: "u", password: "p" });
    const shards = config.getDbShards();
    expect(shards).toHaveLength(1);
    expect(shards[0].host).toBe("new");
  });

  test("removeDbShard removes by name", () => {
    config.addDbShard({ name: "s1", host: "h", port: 1, database: "d", user: "u", password: "p" });
    config.addDbShard({ name: "s2", host: "h", port: 1, database: "d", user: "u", password: "p" });
    config.removeDbShard("s1");
    const shards = config.getDbShards();
    expect(shards).toHaveLength(1);
    expect(shards[0].name).toBe("s2");
  });

  test("getDbShard finds by name", () => {
    config.addDbShard({ name: "my-shard", host: "h", port: 1, database: "d", user: "u", password: "p" });
    expect(config.getDbShard("my-shard")).toBeDefined();
    expect(config.getDbShard("unknown")).toBeUndefined();
  });
});

// ─── Base path scanning ───

describe("scanBasePath", () => {
  const BASE = join(CONFIG_DIR, "scan-base");

  /** A real checkout: .git is a directory. */
  function makeRepo(name: string, remote?: string): string {
    const dir = join(BASE, name);
    mkdirSync(join(dir, ".git"), { recursive: true });
    if (remote) writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
    return dir;
  }

  /** A worktree: .git is a file pointing back at the parent repo. */
  function makeWorktree(name: string, parent: string): string {
    const dir = join(BASE, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), `gitdir: ${parent}/.git/worktrees/${name}\n`);
    return dir;
  }

  beforeEach(() => {
    mkdirSync(BASE, { recursive: true });
    config.setBasePath(BASE);
  });

  test("finds real checkouts and reads their remote", () => {
    makeRepo("proj", "git@github.com:me/proj.git");
    const scanned = config.scanBasePath();
    expect(scanned).toHaveLength(1);
    expect(scanned[0].alias).toBe("proj");
    expect(scanned[0].remote).toBe("git@github.com:me/proj.git");
  });

  test("skips worktrees, whose .git is a file rather than a directory", () => {
    const repo = makeRepo("proj");
    makeWorktree("proj-feature", repo);
    expect(config.scanBasePath().map((r) => r.alias)).toEqual(["proj"]);
  });

  test("syncRepos does not auto-register a worktree as a top-level repo", () => {
    const repo = makeRepo("proj");
    makeWorktree("proj-feature", repo);
    config.syncRepos();
    expect(config.getRepos().map((r) => r.alias)).toEqual(["proj"]);
  });

  test("a worktree alias, once registered, survives the sweep and can be removed", () => {
    const repo = makeRepo("proj");
    const wt = makeWorktree("proj-feature", repo);
    // Registering it is the deliberate act (importing it from the worktrees tab).
    config.addRepo({ alias: "my-wt", path: wt });

    config.syncRepos();
    expect(config.getRepos().map((r) => r.alias).sort()).toEqual(["my-wt", "proj"]);

    // Removal must stick — the sweep used to re-add it under its directory name.
    config.removeRepo("my-wt");
    config.syncRepos();
    expect(config.getRepos().map((r) => r.alias)).toEqual(["proj"]);
  });

  test("keeps worktree entries auto-added before this rule existed", () => {
    const repo = makeRepo("proj");
    const wt = makeWorktree("proj-feature", repo);
    // Pre-existing repos.json from an older version, where the scan added these.
    config.addRepo({ alias: "proj", path: repo });
    config.addRepo({ alias: "proj-feature", path: wt });

    config.syncRepos();

    // Still on disk, so the sweep must not treat it as a stale entry and drop it.
    expect(config.getRepos().map((r) => r.alias).sort()).toEqual(["proj", "proj-feature"]);
  });
});
