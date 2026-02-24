import { Hono } from "hono";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const app = new Hono();

const UPLOAD_DIR = "/tmp/agentdock-uploads";

// Ensure upload directory exists
if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.post("/", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return c.json({ error: "file is required" }, 400);
  }

  // Preserve original extension, generate unique name
  const ext = file.name.includes(".")
    ? "." + file.name.split(".").pop()
    : "";
  const uniqueName = `${randomBytes(8).toString("hex")}${ext}`;
  const filePath = join(UPLOAD_DIR, uniqueName);

  const buffer = await file.arrayBuffer();
  await Bun.write(filePath, buffer);

  return c.json({ path: filePath });
});

export default app;
