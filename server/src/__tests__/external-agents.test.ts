/**
 * Tests for external-agents.ts — the name<->pane-id mapping and cwd->repo matching.
 *
 * Discovery itself shells out to a live tmux server, so the parts worth pinning are
 * the pure ones: a wrong name mapping streams the wrong pane, and a wrong repo match
 * files an agent under someone else's workspace.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as config from "../services/config";
import {
  isExternalAgentName,
  paneIdFromExternalName,
  externalDisplayName,
  worktreesForPath,
  type ExternalAgent,
} from "../services/external-agents";

const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR!;
const WORK_DIR = join(tmpdir(), `agentdock-external-test-${process.pid}`);

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  config.setBasePath(WORK_DIR);
});

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
  rmSync(join(CONFIG_DIR, "..", ".."), { recursive: true, force: true });
});

function agent(overrides: Partial<ExternalAgent> = {}): ExternalAgent {
  return {
    name: "external-44",
    paneId: "%44",
    paneTarget: "workspace:3.4",
    sessionName: "workspace",
    command: "claude",
    path: "/home/u/dev/proj",
    worktrees: [],
    ...overrides,
  };
}

describe("external agent names", () => {
  test("round-trips a pane id through a URL-safe name", () => {
    expect(paneIdFromExternalName("external-44")).toBe("%44");
    expect(isExternalAgentName("external-44")).toBe(true);
  });

  test("does not claim Agentdock's own sessions", () => {
    expect(isExternalAgentName("claude-myrepo")).toBe(false);
    expect(paneIdFromExternalName("claude-myrepo")).toBeNull();
  });

  test("rejects a non-numeric suffix rather than building a bogus tmux target", () => {
    // Guards the WebSocket path: this name arrives straight from the URL.
    expect(paneIdFromExternalName("external-")).toBeNull();
    expect(paneIdFromExternalName("external-4x")).toBeNull();
    expect(paneIdFromExternalName("external-4;kill")).toBeNull();
  });
});

describe("externalDisplayName", () => {
  test("names the agent after the directory it is working in", () => {
    expect(externalDisplayName(agent({ path: "/home/u/dev/proj" }))).toBe("proj");
  });

  test("ignores a trailing slash", () => {
    expect(externalDisplayName(agent({ path: "/home/u/dev/proj/" }))).toBe("proj");
  });

  test("falls back to the pane when there is no usable path", () => {
    expect(externalDisplayName(agent({ path: "" }))).toBe("workspace:3.4");
  });
});

describe("worktreesForPath", () => {
  const REPO = "/home/u/dev/proj";
  const WORKTREE = "/home/u/dev/proj__worktrees/feature";

  test("matches a pane sitting in a registered repo", () => {
    config.addRepo({ alias: "proj", path: REPO });

    expect(worktreesForPath(REPO)).toEqual([{ repoPath: REPO, wtDir: REPO }]);
  });

  test("matches a subdirectory of a registered repo", () => {
    config.addRepo({ alias: "proj", path: REPO });

    expect(worktreesForPath(`${REPO}/server/src`)).toEqual([
      { repoPath: REPO, wtDir: `${REPO}/server/src` },
    ]);
  });

  test("prefers the imported worktree over the repo it forked from", () => {
    // Both are registered and both contain the pane. Matching the shorter path would
    // file the agent under the parent repo's workspace instead of the one it is in.
    config.addRepo({ alias: "proj", path: REPO });
    config.addRepo({ alias: "proj-feature", path: WORKTREE });

    expect(worktreesForPath(WORKTREE)).toEqual([
      { repoPath: WORKTREE, wtDir: WORKTREE },
    ]);
  });

  test("does not treat a sibling with a shared prefix as a containing repo", () => {
    // "/home/u/dev/proj" must not swallow "/home/u/dev/proj__worktrees/feature".
    config.addRepo({ alias: "proj", path: REPO });

    expect(worktreesForPath(WORKTREE)).toEqual([]);
  });

  test("leaves an unregistered path ungrouped", () => {
    config.addRepo({ alias: "proj", path: REPO });

    expect(worktreesForPath("/home/u/elsewhere")).toEqual([]);
  });

  test("ignores a trailing slash on either side", () => {
    config.addRepo({ alias: "proj", path: `${REPO}/` });

    expect(worktreesForPath(`${REPO}/`)).toEqual([{ repoPath: REPO, wtDir: REPO }]);
  });
});
