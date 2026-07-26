/**
 * Tests for the share link (ngrok) service.
 *
 * Nothing here spawns a real ngrok agent. The spawn boundary is injectable, and every
 * decision the service makes is a pure function over captured output + exit code.
 *
 * Not covered (needs a real binary and account): actual tunnel establishment, and
 * whether --basic-auth is plan-gated on a given tier.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import * as ngrok from "../services/ngrok";
import { NGROK_ERROR_REASONS } from "../types";

const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR!;
const PASSWORD_FILE = join(CONFIG_DIR, "auth-password");
const BASIC_AUTH_FILE = join(CONFIG_DIR, "ngrok-basic-auth");

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(join(CONFIG_DIR, "..", ".."), { recursive: true, force: true });
});

const setPassword = (value: string) => writeFileSync(PASSWORD_FILE, value);
const setBasicAuth = (value: string) => writeFileSync(BASIC_AUTH_FILE, value);

// ─── Failure classification ───

describe("classifyNgrokFailure", () => {
  test("exit 127 means the binary is missing", () => {
    const result = ngrok.classifyNgrokFailure("", 127);
    expect(result.reason).toBe("not_installed");
    expect(result.message).toMatch(/not installed/i);
  });

  test("ENOENT in the output also means the binary is missing", () => {
    const result = ngrok.classifyNgrokFailure(
      "/usr/bin/env: 'ngrok': No such file or directory",
      1,
    );
    expect(result.reason).toBe("not_installed");
  });

  test("ERR_NGROK_4018 means no authtoken", () => {
    const output =
      't=2026-07-18T10:00:00+0000 lvl=eror msg="failed to start tunnel" err="authentication failed: Usage of ngrok requires a verified account and authtoken (ERR_NGROK_4018)"';
    const result = ngrok.classifyNgrokFailure(output, 1);
    expect(result.reason).toBe("not_authed");
    expect(result.message).toMatch(/authtoken/i);
  });

  test("ERR_NGROK_108 means another agent is already running", () => {
    const output =
      't=2026-07-18T10:00:00+0000 lvl=eror err="Your account is limited to 1 simultaneous ngrok agent session (ERR_NGROK_108)"';
    const result = ngrok.classifyNgrokFailure(output, 1);
    expect(result.reason).toBe("agent_conflict");
  });

  test("a basic-auth plan rejection is distinguished from a generic failure", () => {
    const output =
      't=2026-07-18T10:00:00+0000 lvl=eror err="The basic-auth option requires a paid plan (ERR_NGROK_9999)"';
    const result = ngrok.classifyNgrokFailure(output, 1);
    expect(result.reason).toBe("basic_auth_unsupported");
  });

  test("basic-auth mentioned without a plan rejection is not misclassified", () => {
    const output = 't=2026-07-18T10:00:00+0000 lvl=info msg="using basic-auth"';
    const result = ngrok.classifyNgrokFailure(output, 1);
    expect(result.reason).not.toBe("basic_auth_unsupported");
  });

  test("still alive with no tunnel is a timeout, not an unknown failure", () => {
    const result = ngrok.classifyNgrokFailure("", null);
    expect(result.reason).toBe("timeout");
  });

  test("unknown failures surface the first logfmt err field", () => {
    const output = 't=2026-07-18T10:00:00+0000 lvl=eror err="something specific broke"';
    const result = ngrok.classifyNgrokFailure(output, 1);
    expect(result.reason).toBe("unknown");
    expect(result.message).toBe("something specific broke");
  });

  test("unknown failures fall back to a generic sentence when there is no field", () => {
    const result = ngrok.classifyNgrokFailure("total gibberish", 1);
    expect(result.reason).toBe("unknown");
    expect(result.message).toBe("ngrok exited unexpectedly.");
  });
});

describe("truncateDetail", () => {
  test("returns undefined for empty output", () => {
    expect(ngrok.truncateDetail("   ")).toBeUndefined();
  });

  test("truncates at 300 characters", () => {
    const detail = ngrok.truncateDetail("x".repeat(500))!;
    expect(detail.length).toBe(301); // 300 + ellipsis
    expect(detail.endsWith("…")).toBe(true);
  });

  test("leaves short output intact", () => {
    expect(ngrok.truncateDetail("short")).toBe("short");
  });
});

// ─── Protection / gate ───

describe("getProtection", () => {
  test("no password and no basic auth is unprotected", () => {
    expect(ngrok.getProtection()).toBe("none");
  });

  test("a short password counts as weak", () => {
    setPassword("abcd");
    expect(ngrok.getProtection()).toBe("weak-password");
  });

  test("a long password counts as protected", () => {
    setPassword("a-genuinely-long-password");
    expect(ngrok.getProtection()).toBe("password");
  });

  test("basic auth wins over a weak password", () => {
    setPassword("abcd");
    setBasicAuth("user:pass");
    expect(ngrok.getProtection()).toBe("basic-auth");
  });
});

describe("requiresAcknowledgement", () => {
  test.each([
    ["nothing set", null, null, true],
    ["4-char password", "abcd", null, true],
    ["12-char password", "abcdefghijkl", null, false],
    ["basic auth only", null, "user:pass", false],
    ["both", "abcd", "user:pass", false],
  ])("%s", (_label, password, basicAuth, expected) => {
    if (password) setPassword(password);
    if (basicAuth) setBasicAuth(basicAuth);
    expect(ngrok.requiresAcknowledgement()).toBe(expected as boolean);
  });

  test("exactly the minimum length is accepted", () => {
    setPassword("x".repeat(ngrok.MIN_STRONG_PASSWORD));
    expect(ngrok.requiresAcknowledgement()).toBe(false);
  });
});

// ─── Argument construction ───

describe("buildNgrokArgs", () => {
  test("dials https and rewrites the host header for the Vite dev server", () => {
    const args = ngrok.buildNgrokArgs({ port: "5173" });
    expect(args[0]).toBe("http");
    expect(args).toContain("https://127.0.0.1:5173");
    expect(args).toContain("--host-header=rewrite");
  });

  test("forces parseable logging on stdout", () => {
    const args = ngrok.buildNgrokArgs({ port: "5173" });
    expect(args).toContain("--log=stdout");
    expect(args).toContain("--log-format=logfmt");
  });

  test("omits --basic-auth when none is configured", () => {
    expect(ngrok.buildNgrokArgs({ port: "5173" })).not.toContain("--basic-auth");
    expect(ngrok.buildNgrokArgs({ port: "5173", basicAuth: null })).not.toContain("--basic-auth");
  });

  test("passes --basic-auth through when configured", () => {
    const args = ngrok.buildNgrokArgs({ port: "5173", basicAuth: "user:pass" });
    expect(args).toContain("--basic-auth");
    expect(args[args.indexOf("--basic-auth") + 1]).toBe("user:pass");
  });
});

describe("validPort", () => {
  test.each([
    ["5173", "5173"],
    [4800, "4800"],
    ["0", null],
    ["99999999", null],
    ["abc", null],
    [null, null],
    ["", null],
  ])("validPort(%p) → %p", (input, expected) => {
    expect(ngrok.validPort(input)).toBe(expected as string | null);
  });
});

describe("tunnelMatchesPort", () => {
  test("matches either host form ngrok may report", () => {
    expect(ngrok.tunnelMatchesPort({ url: "u", addr: "https://127.0.0.1:5173" }, "5173")).toBe(true);
    expect(ngrok.tunnelMatchesPort({ url: "u", addr: "https://localhost:5173" }, "5173")).toBe(true);
  });

  test("rejects a tunnel pointing at a different port", () => {
    expect(ngrok.tunnelMatchesPort({ url: "u", addr: "https://127.0.0.1:3000" }, "5173")).toBe(false);
  });
});

// ─── Start path ───

describe("startNgrokTunnel", () => {
  test("reports not_installed without spawning ngrok when the binary is absent", async () => {
    const calls: string[][] = [];
    const spawnFn = ((command: string, args: string[] = []) => {
      calls.push([command, ...args]);
      // `which ngrok` finding nothing → non-zero exit.
      return { exited: Promise.resolve(1), stdout: null, stderr: null, kill() {} } as any;
    }) as ngrok.SpawnFn;

    const result = await ngrok.startNgrokTunnel({ port: "5173", spawnFn });

    expect(result.url).toBeNull();
    expect(result.reason).toBe("not_installed");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("which");
  });
});

// ─── Type parity ───

describe("type parity", () => {
  test("the reason union matches the literal list the client mirrors", () => {
    expect([...NGROK_ERROR_REASONS]).toEqual([
      "not_installed",
      "not_authed",
      "basic_auth_unsupported",
      "agent_conflict",
      "timeout",
      "unprotected",
      "unknown",
    ]);
  });
});
