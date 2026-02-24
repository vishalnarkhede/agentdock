import { Hono } from "hono";

const app = new Hono();

const WHISPER_URL = "http://localhost:8300/transcribe";

app.post("/", async (c) => {
  const formData = await c.req.formData();
  const audio = formData.get("audio");
  if (!audio || !(audio instanceof File)) {
    return c.json({ error: "audio file is required" }, 400);
  }

  const upstream = new FormData();
  upstream.append("file", audio, "audio.webm");

  let res: Response;
  try {
    res = await fetch(WHISPER_URL, { method: "POST", body: upstream });
  } catch {
    return c.json({ error: "Whisper server not reachable at " + WHISPER_URL }, 503);
  }

  if (!res.ok) {
    return c.json({ error: "Whisper server error" }, 502);
  }

  const data = (await res.json()) as { text: string };
  return c.json({ text: data.text });
});

export default app;
