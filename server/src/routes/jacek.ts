import { Hono } from "hono";
import { existsSync, readFileSync, mkdirSync } from "fs";

const app = new Hono();

const RESPONSES_DIR = "/tmp/jacek-responses";

// Ensure directory exists
mkdirSync(RESPONSES_DIR, { recursive: true });

// Read the latest response file
app.get("/response", (c) => {
  const filePath = `${RESPONSES_DIR}/response.md`;
  if (!existsSync(filePath)) {
    return c.json({ content: null });
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    return c.json({ content });
  } catch {
    return c.json({ content: null });
  }
});

export default app;
