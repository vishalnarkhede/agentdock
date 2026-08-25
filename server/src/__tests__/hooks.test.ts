/**
 * Tests for status-hook install detection.
 *
 * Pure — operates on a parsed settings object, so it never touches
 * the real ~/.claude/settings.json.
 */

import { describe, test, expect } from "bun:test";
import { readInstalledHooks, REQUIRED_HOOK_EVENTS } from "../services/config";

const ALL = REQUIRED_HOOK_EVENTS.map((h) => h.event);

function withHooks(events: string[], command = "/x/hooks/status-hook.sh working") {
  const hooks: Record<string, unknown> = {};
  for (const e of events) hooks[e] = [{ hooks: [{ type: "command", command }] }];
  return { hooks };
}

describe("readInstalledHooks", () => {
  test("reports every required event as missing when settings are empty", () => {
    const r = readInstalledHooks({});
    expect(r.ok).toBe(false);
    expect(r.installed).toEqual([]);
    expect(r.missing.sort()).toEqual([...ALL].sort());
  });

  test("recognises a full install", () => {
    const r = readInstalledHooks(withHooks(ALL));
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.installed.sort()).toEqual([...ALL].sort());
  });

  test("reports a partial install precisely", () => {
    const r = readInstalledHooks(withHooks(["Stop", "PreToolUse"]));
    expect(r.ok).toBe(false);
    expect(r.installed.sort()).toEqual(["PreToolUse", "Stop"]);
    expect(r.missing).not.toContain("Stop");
    expect(r.missing).toContain("Notification");
  });

  test("someone else's hook on the same event does not count as ours", () => {
    const r = readInstalledHooks(withHooks(ALL, "/usr/local/bin/my-own-hook.sh"));
    expect(r.ok).toBe(false);
    expect(r.installed).toEqual([]);
  });

  test("survives malformed hook entries instead of throwing", () => {
    for (const bad of [
      { hooks: { Stop: "not-an-array" } },
      { hooks: { Stop: [null] } },
      { hooks: { Stop: [{ hooks: null }] } },
      { hooks: { Stop: [{ hooks: [{ command: null }] }] } },
      { hooks: null },
      {},
    ]) {
      expect(() => readInstalledHooks(bad as any)).not.toThrow();
      expect(readInstalledHooks(bad as any).ok).toBe(false);
    }
  });

  test("every required event documents what it means, for the Health panel", () => {
    expect(REQUIRED_HOOK_EVENTS).toHaveLength(5);
    for (const h of REQUIRED_HOOK_EVENTS) {
      expect(h.means.length).toBeGreaterThan(10);
      expect(["working", "waiting"]).toContain(h.status);
    }
  });
});
