import { Hono } from "hono";
import { spawn, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import { getNgrokBasicAuth } from "../services/config";

const app = new Hono();

let ngrokProcess: ChildProcess | null = null;

async function fetchNgrokUrl(): Promise<string | null> {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (!res.ok) return null;
    const data = await res.json() as any;
    const tunnel = data.tunnels?.find((t: any) => t.proto === "https");
    return tunnel?.public_url ?? data.tunnels?.[0]?.public_url ?? null;
  } catch {
    return null;
  }
}

// Always check the real ngrok local API — works even if server restarted
app.get("/status", async (c) => {
  const url = await fetchNgrokUrl();
  return c.json({ running: url !== null, url });
});

app.post("/start", async (c) => {
  // Already running (externally or via us)
  const existingUrl = await fetchNgrokUrl();
  if (existingUrl) {
    return c.json({ ok: true, url: existingUrl });
  }

  const port = process.env.NGROK_PORT || "5173";
  const args = ["http", port];
  const basicAuth = getNgrokBasicAuth();
  if (basicAuth) args.push("--basic-auth", basicAuth);
  const proc = spawn("ngrok", args, { detached: false });

  proc.on("exit", () => {
    if (ngrokProcess === proc) ngrokProcess = null;
  });

  ngrokProcess = proc;

  // Poll until tunnel is up (max 8s)
  let url: string | null = null;
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    url = await fetchNgrokUrl();
    if (url) break;
  }

  return c.json({ ok: true, url });
});

app.post("/stop", async (c) => {
  // Kill our tracked process if we have one
  if (ngrokProcess) {
    ngrokProcess.kill();
    ngrokProcess = null;
  }
  // Also kill any external ngrok process (e.g. started before server restart)
  try {
    execSync("pkill -f 'ngrok http'", { stdio: "ignore" });
  } catch {
    // pkill exits non-zero if nothing matched — that's fine
  }
  return c.json({ ok: true });
});

export default app;
