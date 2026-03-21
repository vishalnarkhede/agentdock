import { Hono } from "hono";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

const app = new Hono();

let ngrokProcess: ChildProcess | null = null;
let ngrokUrl: string | null = null;

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

app.get("/status", async (c) => {
  const running = ngrokProcess !== null && ngrokProcess.exitCode === null;
  if (running && !ngrokUrl) {
    ngrokUrl = await fetchNgrokUrl();
  }
  return c.json({ running, url: ngrokUrl });
});

app.post("/start", async (c) => {
  if (ngrokProcess && ngrokProcess.exitCode === null) {
    const url = await fetchNgrokUrl();
    return c.json({ ok: true, url });
  }

  ngrokUrl = null;
  const port = process.env.NGROK_PORT || "5173";
  const proc = spawn("ngrok", ["http", port], { detached: false });

  proc.on("exit", () => {
    if (ngrokProcess === proc) {
      ngrokProcess = null;
      ngrokUrl = null;
    }
  });

  ngrokProcess = proc;

  // Poll ngrok local API until tunnel is up (max 8s)
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const url = await fetchNgrokUrl();
    if (url) {
      ngrokUrl = url;
      break;
    }
  }

  return c.json({ ok: true, url: ngrokUrl });
});

app.post("/stop", (c) => {
  if (ngrokProcess) {
    ngrokProcess.kill();
    ngrokProcess = null;
    ngrokUrl = null;
  }
  return c.json({ ok: true });
});

export default app;
