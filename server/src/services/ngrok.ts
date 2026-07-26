/**
 * Share link (ngrok tunnel) management.
 *
 * The route layer is thin HTTP glue over this module. Everything here that makes a
 * decision is a pure function so it can be tested without a real ngrok binary or account.
 */

import { spawnTool } from "./spawn";
import { getNgrokBasicAuth, getAuthPassword } from "./config";
import type { NgrokErrorReason, NgrokProtection } from "../types";

/** Passwords shorter than this trigger the "you're about to expose this" gate. */
export const MIN_STRONG_PASSWORD = 12;

const DETAIL_MAX = 300;
const TUNNEL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

export type SpawnFn = typeof spawnTool;

let ngrokProcess: ReturnType<typeof spawnTool> | null = null;

// ─── Pure helpers ───

export function validPort(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const port = String(value);
  if (!/^\d{2,5}$/.test(port)) return null;
  const n = Number(port);
  return n > 0 && n <= 65535 ? port : null;
}

/** ngrok reports its target as the address we dialled, which may use either host form. */
export function tunnelMatchesPort(tunnel: NgrokTunnel, port: string): boolean {
  return (
    tunnel.addr === `https://127.0.0.1:${port}` || tunnel.addr === `https://localhost:${port}`
  );
}

/**
 * Resolve ngrok on the *augmented* PATH. A plain `command -v` in the server's own
 * environment misses brew installs when the server was started from a GUI/launchd
 * context, which is the case spawnTool exists to handle.
 */
export async function hasNgrokExecutable(spawnFn: SpawnFn = spawnTool): Promise<boolean> {
  try {
    const proc = spawnFn("which", ["ngrok"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export function buildNgrokArgs(opts: { port: string; basicAuth?: string | null }): string[] {
  // Vite serves HTTPS via basicSsl, so ngrok must dial https and rewrite the Host header.
  const args = [
    "http",
    `https://127.0.0.1:${opts.port}`,
    "--host-header=rewrite",
    // Force deterministic, parseable output. In a non-TTY ngrok logs to stdout.
    "--log=stdout",
    "--log-format=logfmt",
    "--log-level=info",
  ];
  if (opts.basicAuth) args.push("--basic-auth", opts.basicAuth);
  return args;
}

/** Pull the first err="..." / msg="..." value out of a logfmt line. */
function firstLogfmtField(output: string): string | null {
  const match = output.match(/\b(?:err|msg)="([^"]+)"/);
  return match?.[1] ?? null;
}

export function truncateDetail(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX)}…` : trimmed;
}

/**
 * Work out *why* ngrok didn't produce a tunnel.
 *
 * `exitCode === null` means the process was still alive when we gave up waiting.
 * Matching is done over the captured output rather than against hard-coded error
 * codes alone, because ngrok's plan-gating messages differ between account tiers.
 */
export function classifyNgrokFailure(
  output: string,
  exitCode: number | null,
): { reason: NgrokErrorReason; message: string } {
  if (exitCode === 127 || /ENOENT|command not found|No such file or directory/i.test(output)) {
    return {
      reason: "not_installed",
      message: "ngrok is not installed, or not on the server's PATH.",
    };
  }

  if (/ERR_NGROK_(4018|105|107)\b|authtoken|requires a verified account/i.test(output)) {
    return {
      reason: "not_authed",
      message: "ngrok needs an authtoken before it can open tunnels.",
    };
  }

  if (/ERR_NGROK_108\b|simultaneous ngrok agent|limited to 1/i.test(output)) {
    return {
      reason: "agent_conflict",
      message: "Another ngrok agent is already running on this account.",
    };
  }

  if (/basic.?auth/i.test(output) && /not authorized|upgrade|plan|paid|ERR_NGROK_/i.test(output)) {
    return {
      reason: "basic_auth_unsupported",
      message: "Your ngrok plan does not allow basic auth on tunnels.",
    };
  }

  if (exitCode === null) {
    return {
      reason: "timeout",
      message: `ngrok started but no tunnel appeared within ${TUNNEL_TIMEOUT_MS / 1000} seconds.`,
    };
  }

  return {
    reason: "unknown",
    message: firstLogfmtField(output) ?? "ngrok exited unexpectedly.",
  };
}

/**
 * ngrok basic auth wins because it challenges before the request ever reaches us.
 * A password shorter than MIN_STRONG_PASSWORD counts as "weak" rather than "none":
 * access is still gated, but it's brute-forceable over a public URL.
 */
export function getProtection(): NgrokProtection {
  if (getNgrokBasicAuth()) return "basic-auth";
  const password = getAuthPassword();
  if (!password) return "none";
  return password.length >= MIN_STRONG_PASSWORD ? "password" : "weak-password";
}

export function requiresAcknowledgement(): boolean {
  const protection = getProtection();
  return protection === "none" || protection === "weak-password";
}

// ─── Tunnel discovery ───

export interface NgrokTunnel {
  url: string;
  addr?: string;
}

/**
 * Ask the local ngrok agent what it's serving. This is deliberately the only source of
 * truth for "is it running" — it stays correct across a server restart, when our own
 * process handle is gone.
 */
export async function fetchNgrokTunnel(): Promise<NgrokTunnel | null> {
  try {
    const res = await fetch(NGROK_API);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const tunnel = data.tunnels?.find((t: any) => t.proto === "https") ?? data.tunnels?.[0];
    if (!tunnel?.public_url) return null;
    return { url: tunnel.public_url, addr: tunnel.config?.addr };
  } catch {
    return null;
  }
}

// ─── Process lifecycle ───

/** Drain both streams into one string; ngrok writes agent logs to stdout in non-TTY mode. */
async function collectOutput(proc: ReturnType<typeof spawnTool>): Promise<string> {
  const read = async (stream: unknown): Promise<string> => {
    if (!stream || typeof stream === "number") return "";
    try {
      return await new Response(stream as ReadableStream).text();
    } catch {
      return "";
    }
  };
  const [out, err] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
  return [out, err].filter(Boolean).join("\n");
}

export async function stopNgrokProcess(): Promise<void> {
  if (ngrokProcess) {
    // Kill only the agent we started — a blanket pkill would take out unrelated
    // tunnels the user is running for other projects.
    try {
      ngrokProcess.kill();
      await ngrokProcess.exited;
    } catch {
      // Already gone.
    }
    ngrokProcess = null;
    return;
  }

  // No tracked handle (e.g. the server restarted under a live tunnel) — fall back
  // to pkill, which is the only way to reach an orphaned agent.
  try {
    spawnTool("pkill", ["-f", "ngrok http"], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // pkill exits non-zero when nothing matched — not an error.
  }
}

export interface StartResult {
  url: string | null;
  error?: string;
  reason?: NgrokErrorReason;
  detail?: string;
}

export async function startNgrokTunnel(
  opts: { port: string; spawnFn?: SpawnFn },
): Promise<StartResult> {
  const spawnFn = opts.spawnFn ?? spawnTool;

  // Fail fast and precisely rather than waiting out the timeout on a missing binary.
  if (!(await hasNgrokExecutable(spawnFn))) {
    const { reason, message } = classifyNgrokFailure("", 127);
    return { url: null, error: message, reason };
  }

  const args = buildNgrokArgs({ port: opts.port, basicAuth: getNgrokBasicAuth() });

  let proc: ReturnType<typeof spawnTool>;
  try {
    proc = spawnFn("ngrok", args, { stdout: "pipe", stderr: "pipe" });
  } catch (err: any) {
    // Running through /usr/bin/env normally turns a missing binary into exit 127
    // rather than a throw, but stay defensive.
    const detail = err?.message ?? "";
    const { reason, message } = classifyNgrokFailure(detail, 127);
    return { url: null, error: message, reason, detail: truncateDetail(detail) };
  }

  ngrokProcess = proc;
  const outputPromise = collectOutput(proc);

  // Race the tunnel appearing against the process dying. ngrok exits in about a second
  // on an auth or plan failure, so this reports the real cause immediately instead of
  // burning the full timeout on every failure.
  const exited = proc.exited.then((code) => ({ kind: "exit" as const, code }));
  const deadline = Date.now() + TUNNEL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const settled = await Promise.race([
      exited,
      new Promise<{ kind: "tick" }>((r) => setTimeout(() => r({ kind: "tick" }), POLL_INTERVAL_MS)),
    ]);

    if (settled.kind === "exit") {
      ngrokProcess = null;
      const output = await outputPromise;
      const { reason, message } = classifyNgrokFailure(output, settled.code ?? null);
      return { url: null, error: message, reason, detail: truncateDetail(output) };
    }

    const tunnel = await fetchNgrokTunnel();
    if (tunnel) return { url: tunnel.url };
  }

  // Still alive but never published a tunnel.
  const { reason, message } = classifyNgrokFailure("", null);
  return { url: null, error: message, reason, detail: undefined };
}
