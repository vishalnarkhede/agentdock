/**
 * Tests for config.ts — file-based configuration CRUD.
 *
 * Uses a temp directory (set by test-preload.ts) to avoid touching real config files.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
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

  test("saveSessionAgentType works for cursor", () => {
    config.saveSessionAgentType("test-session", "cursor");
    expect(config.getSessionAgentType("test-session")).toBe("cursor");
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

  test("deleteSessionMeta removes the file", () => {
    config.saveWorktreeMeta("test-session", "/repo", "/wt");
    config.deleteSessionMeta("test-session");
    expect(config.getSessionMeta("test-session")).toEqual([]);
  });
});

// ─── Rename Session Config ───

describe("renameSessionConfig", () => {
  test("moves worktree meta and all per-session flag files", () => {
    config.saveWorktreeMeta("claude-old", "/repo", "/wt");
    config.saveSessionAgentType("claude-old", "claude");
    config.saveSessionProperties("claude-old", { priority: "high" });
    config.saveSessionType("claude-old", "ticket");
    config.saveSessionSkipPerms("claude-old", true);

    config.renameSessionConfig("claude-old", "claude-new");

    expect(config.getSessionMeta("claude-old")).toEqual([]);
    expect(config.getSessionMeta("claude-new")).toEqual([{ repoPath: "/repo", wtDir: "/wt" }]);
    expect(config.getSessionAgentType("claude-new")).toBe("claude");
    expect(config.getSessionProperties("claude-new")).toEqual({ priority: "high" });
    expect(config.getSessionType("claude-new")).toBe("ticket");
    expect(config.getSessionSkipPerms("claude-new")).toBe(true);
    expect(config.getSessionAgentType("claude-old")).toBeNull();
  });

  test("repoints children whose parent references the old name", () => {
    config.saveSessionParent("claude-old-sub-1", "claude-old");
    config.saveSessionParent("claude-other-sub-1", "claude-other");

    config.renameSessionConfig("claude-old", "claude-new");

    expect(config.getSessionParent("claude-old-sub-1")).toBe("claude-new");
    expect(config.getSessionParent("claude-other-sub-1")).toBe("claude-other");
    expect(config.getSessionChildren("claude-new")).toContain("claude-old-sub-1");
  });

  test("preserves position in the session order", () => {
    config.saveSessionOrder(["claude-a", "claude-old", "claude-b"]);
    config.renameSessionConfig("claude-old", "claude-new");
    expect(config.getSessionOrder()).toEqual(["claude-a", "claude-new", "claude-b"]);
  });

  test("updates pinned sessions preference", () => {
    config.savePreferences({ pinnedSessions: ["claude-old", "claude-x"] });
    config.renameSessionConfig("claude-old", "claude-new");
    expect(config.getPreferences().pinnedSessions).toEqual(["claude-new", "claude-x"]);
  });

  test("moves the plan file", () => {
    const plansDir = join(CONFIG_DIR, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "claude-old.md"), "# my plan");
    config.renameSessionConfig("claude-old", "claude-new");
    expect(existsSync(join(plansDir, "claude-old.md"))).toBe(false);
    expect(readFileSync(join(plansDir, "claude-new.md"), "utf-8")).toBe("# my plan");
  });

  test("is a no-op when names are equal", () => {
    config.saveSessionProperties("claude-same", { a: "b" });
    config.renameSessionConfig("claude-same", "claude-same");
    expect(config.getSessionProperties("claude-same")).toEqual({ a: "b" });
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

describe("resolveAlias with a directory path", () => {
  // "Fork this session here" sends the worktree path, which is never a
  // configured alias. It used to fail with
  // "Unknown alias: /Users/…/.worktrees/wt-abc123/chat".
  //
  // Sandboxed under the test config dir. An earlier version of this block
  // computed the base as ~/projects and created directories in the real one.
  // Its own temp root, not under CONFIG_DIR — other suites wipe that between
  // files, which made these pass alone and fail in the full run.
  let base: string;

  let prevEnv: string | undefined;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "agentdock-alias-"));
    // getBasePath() checks this env var before the config file, and another
    // suite sets it at module scope, which leaks across files in one bun run.
    prevEnv = process.env.AGENTDOCK_BASE_PATH;
    process.env.AGENTDOCK_BASE_PATH = base;
    config.setBasePath(base);
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AGENTDOCK_BASE_PATH;
    else process.env.AGENTDOCK_BASE_PATH = prevEnv;
  });

  afterAll(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* already gone */ }
  });

  test("still resolves a configured alias", () => {
    config.addRepo({ alias: "demo", path: join(base, "demo") });
    expect(config.resolveAlias("demo")?.path).toBe(join(base, "demo"));
  });

  test("resolves an existing directory inside the base path", () => {
    const dir = join(base, "forked-repo");
    mkdirSync(dir, { recursive: true });
    const r = config.resolveAlias(dir);
    expect(r?.path).toBe(dir);
    expect(r?.alias).toBe("forked-repo");
  });

  test("resolves a worktree path, the case that was broken", () => {
    const wt = join(base, ".worktrees", "wt-abc123", "chat");
    mkdirSync(wt, { recursive: true });
    expect(config.resolveAlias(wt)?.path).toBe(wt);
  });

  test("refuses a directory outside the base path", () => {
    expect(config.resolveAlias("/etc")).toBeUndefined();
    expect(config.resolveAlias("/")).toBeUndefined();
  });

  test("refuses a traversal that escapes the base path", () => {
    expect(config.resolveAlias(join(base, "..", "..", "etc"))).toBeUndefined();
  });

  test("refuses a path that does not exist", () => {
    expect(config.resolveAlias(join(base, "definitely-not-here"))).toBeUndefined();
  });

  test("refuses a file, since an agent needs a directory", () => {
    const f = join(base, "a-file.txt");
    writeFileSync(f, "x");
    expect(config.resolveAlias(f)).toBeUndefined();
  });

  test("an unknown bare name is still unknown", () => {
    expect(config.resolveAlias("no-such-alias")).toBeUndefined();
  });
});

// ─── Plans ───

describe("getPlan", () => {
  const PLANS_DIR = join(CONFIG_DIR, "plans");

  function writePlan(name: string, body: string) {
    mkdirSync(PLANS_DIR, { recursive: true });
    writeFileSync(join(PLANS_DIR, `${name}.md`), body);
  }

  test("returns the session's own plan", () => {
    writePlan("claude-alpha", "# alpha");
    expect(config.getPlan("claude-alpha")).toBe("# alpha");
  });

  test("returns null rather than another session's plan", () => {
    writePlan("claude-alpha", "# alpha");
    writePlan("claude-beta", "# beta");
    expect(config.getPlan("claude-gamma")).toBeNull();
  });

  test("returns null when the plans directory is empty", () => {
    mkdirSync(PLANS_DIR, { recursive: true });
    expect(config.getPlan("claude-alpha")).toBeNull();
  });

  test("returns null when there is no plans directory at all", () => {
    expect(config.getPlan("claude-alpha")).toBeNull();
  });

  test("finds a plan filed without the claude- prefix", () => {
    writePlan("alpha", "# alpha");
    expect(config.getPlan("claude-alpha")).toBe("# alpha");
  });

  test("prefers the exact name over the bare one", () => {
    writePlan("claude-alpha", "# prefixed");
    writePlan("alpha", "# bare");
    expect(config.getPlan("claude-alpha")).toBe("# prefixed");
  });

  test("planFileNames covers both spellings", () => {
    expect(config.planFileNames("claude-alpha")).toEqual(["claude-alpha", "alpha"]);
    expect(config.planFileNames("alpha")).toEqual(["alpha", "claude-alpha"]);
  });
});

// ─── Agent MCP config (read-only) ───

describe("readMcpNames", () => {
  const dir = join(CONFIG_DIR, "mcp-probe");
  const file = join(dir, "claude.json");

  function write(body: unknown) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  }

  test("returns nothing when the file is absent", () => {
    expect(config.readMcpNames(join(dir, "nope.json"))).toEqual([]);
  });

  test("returns nothing for a corrupt file", () => {
    write("{not json");
    expect(config.readMcpNames(file)).toEqual([]);
  });

  test("returns nothing when there are no servers", () => {
    write({ someOtherKey: 1 });
    expect(config.readMcpNames(file)).toEqual([]);
  });

  test("reports the server name, its command and its args", () => {
    write({
      mcpServers: {
        linear: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"] },
      },
    });
    const names = config.readMcpNames(file);
    expect(names).toContain("linear");
    expect(names).toContain("npx");
    expect(names).toContain("https://mcp.linear.app/mcp");
  });

  test("finds Linear when only the url mentions it", () => {
    write({ mcpServers: { tickets: { command: "npx", args: ["mcp-remote", "https://mcp.linear.app/mcp"] } } });
    expect(config.readMcpNames(file).some((n) => /linear/i.test(n))).toBe(true);
  });

  test("survives entries with no command or args", () => {
    write({ mcpServers: { notion: {}, stitch: { args: "not-an-array" } } });
    expect(config.readMcpNames(file).sort()).toEqual(["notion", "stitch"]);
  });
});
