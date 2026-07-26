import { Hono } from "hono";
import {
  fetchNgrokTunnel,
  getProtection,
  requiresAcknowledgement,
  startNgrokTunnel,
  stopNgrokProcess,
  tunnelMatchesPort,
  validPort,
  type SpawnFn,
} from "../services/ngrok";
import type { NgrokStatus } from "../types";

const app = new Hono();

/** Overridable so route tests can assert the gate rejects before anything is spawned. */
let spawnFn: SpawnFn | undefined;
export function __setSpawnFnForTests(fn: SpawnFn | undefined): void {
  spawnFn = fn;
}

// Always ask the real ngrok agent — this stays correct across a server restart, when
// our own process handle is gone.
app.get("/status", async (c) => {
  const tunnel = await fetchNgrokTunnel();
  const port = validPort(c.req.query("targetPort"));
  const stale = tunnel !== null && port !== null && !tunnelMatchesPort(tunnel, port);

  return c.json({
    running: tunnel !== null && !stale,
    url: stale ? null : tunnel?.url ?? null,
    protection: getProtection(),
  } satisfies NgrokStatus);
});

app.post("/start", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      targetPort?: string;
      acknowledgeUnprotected?: boolean;
    };
    const port = validPort(body.targetPort) || process.env.NGROK_PORT || "5173";

    // Reuse a tunnel already pointing at the right place; replace one that isn't.
    const existing = await fetchNgrokTunnel();
    if (existing && tunnelMatchesPort(existing, port)) {
      return c.json({
        running: true,
        url: existing.url,
        protection: getProtection(),
      } satisfies NgrokStatus);
    }

    // Gate before spawning anything. This publishes a dashboard that can run shell
    // commands on this machine, so a weak or absent password needs acknowledgement.
    if (requiresAcknowledgement() && !body.acknowledgeUnprotected) {
      const protection = getProtection();
      return c.json(
        {
          running: false,
          url: null,
          reason: "unprotected",
          error:
            protection === "none"
              ? "No password is set — anyone with the link could run shell commands on this machine."
              : "Your password is short enough to guess — anyone with the link could run shell commands on this machine.",
          protection,
        } satisfies NgrokStatus,
        409,
      );
    }

    if (existing) await stopNgrokProcess();

    const result = await startNgrokTunnel({ port, spawnFn });
    return c.json({
      running: result.url !== null,
      url: result.url,
      error: result.error,
      reason: result.reason,
      detail: result.detail,
      protection: getProtection(),
    } satisfies NgrokStatus);
  } catch (err: any) {
    return c.json(
      {
        running: false,
        url: null,
        error: err?.message ?? "Failed to start the share link.",
        reason: "unknown",
        protection: getProtection(),
      } satisfies NgrokStatus,
      500,
    );
  }
});

app.post("/stop", async (c) => {
  await stopNgrokProcess();
  return c.json({ ok: true });
});

export default app;
