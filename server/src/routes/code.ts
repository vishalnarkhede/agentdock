import { Hono } from "hono";
import { resolve, join } from "path";
import { getBasePath } from "../services/config";
import {
  findDefinitions,
  documentSymbols,
  getSymbolIndex,
  invalidateSymbols,
} from "../services/symbol-index";

const app = new Hono();

function isWithinBasePath(p: string): boolean {
  const base = resolve(getBasePath());
  const r = resolve(p);
  return r === base || r.startsWith(base + "/");
}

function parseRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((r) => resolve(r.trim())).filter(Boolean);
}

function roots(c: any): { roots: string[]; error?: Response } {
  const rs = parseRoots(c.req.query("roots"));
  const list = rs.length > 0 ? rs : [resolve(getBasePath())];
  for (const r of list) {
    if (!isWithinBasePath(r)) {
      return { roots: [], error: c.json({ error: "roots outside allowed directory" }, 403) };
    }
  }
  return { roots: list };
}

// GET /api/code/definition?name=&roots=&from=<abs file the click came from>
app.get("/definition", async (c) => {
  const name = (c.req.query("name") || "").trim();
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) {
    return c.json({ candidates: [], indexed: 0, truncated: false });
  }
  const { roots: list, error } = roots(c);
  if (error) return error;

  const from = c.req.query("from");
  try {
    const r = await findDefinitions(list, name, from ? resolve(from) : undefined);
    return c.json({ ...r, candidates: r.candidates.filter((x) => isWithinBasePath(x.path)) });
  } catch (err: any) {
    return c.json({ error: err?.message || "lookup failed" }, 500);
  }
});

// GET /api/code/symbols?path=<abs file>&roots=
app.get("/symbols", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  const abs = resolve(path);
  if (!isWithinBasePath(abs)) return c.json({ error: "path outside allowed directory" }, 403);

  const { roots: list, error } = roots(c);
  if (error) return error;

  const root = list.find((r) => abs === r || abs.startsWith(r + "/"));
  if (!root) return c.json({ symbols: [] });

  try {
    const symbols = await documentSymbols(root, abs.slice(root.length + 1));
    return c.json({ symbols });
  } catch (err: any) {
    return c.json({ error: err?.message || "lookup failed" }, 500);
  }
});

// GET /api/code/index-status?roots=
app.get("/index-status", async (c) => {
  const { roots: list, error } = roots(c);
  if (error) return error;
  const out = await Promise.all(
    list.map(async (root) => {
      try {
        const idx = await getSymbolIndex(root);
        return { root, symbols: idx.count, files: idx.files.size, builtAt: idx.builtAt, rescanned: idx.scanned };
      } catch {
        return { root, symbols: 0, files: 0, builtAt: 0, rescanned: 0 };
      }
    }),
  );
  return c.json({ roots: out });
});

app.post("/reindex", async (c) => {
  const { roots: list, error } = roots(c);
  if (error) return error;
  for (const r of list) invalidateSymbols(r);
  return c.json({ ok: true });
});

export default app;
