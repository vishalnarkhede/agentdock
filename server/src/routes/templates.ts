import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const app = new Hono();

const CONFIG_DIR = join(homedir(), ".config", "agentdock");
const TEMPLATES_FILE = join(CONFIG_DIR, "templates.json");

export interface SessionTemplate {
  id: string;
  name: string;
  targets: string[];
  prompt?: string;
  isolated?: boolean;
  grouped?: boolean;
}

function loadTemplates(): SessionTemplate[] {
  if (!existsSync(TEMPLATES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TEMPLATES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveTemplates(templates: SessionTemplate[]): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

app.get("/", (c) => {
  return c.json(loadTemplates());
});

app.post("/", async (c) => {
  const body = await c.req.json() as Omit<SessionTemplate, "id">;
  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }
  const templates = loadTemplates();
  const template: SessionTemplate = {
    ...body,
    id: Date.now().toString(36),
  };
  templates.push(template);
  saveTemplates(templates);
  return c.json(template, 201);
});

app.delete("/:id", (c) => {
  const id = c.req.param("id");
  const templates = loadTemplates().filter((t) => t.id !== id);
  saveTemplates(templates);
  return c.json({ ok: true });
});

export default app;
