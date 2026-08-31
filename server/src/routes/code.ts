import { Hono } from "hono";
import { resolve, sep } from "path";
import { readFile } from "fs/promises";
import { getBasePath } from "../services/config";
import {
  findDefinitions,
  documentSymbols,
  getSymbolIndex,
  invalidateSymbols,
} from "../services/symbol-index";
import * as lsp from "../services/lsp";

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

interface PositionBody {
  roots: string[];
  path: string;
  line: number;
  col: number;
  text?: string;
}

/**
 * Position-based lookups arrive as POST because they may carry the unsaved
 * buffer: a definition resolved against the file on disk lands on the wrong
 * line the moment the reader has typed anything.
 */
async function positionBody(c: any): Promise<{ body?: PositionBody; error?: Response }> {
  const raw = await c.req.json().catch(() => null);
  if (!raw?.path || typeof raw.path !== "string") {
    return { error: c.json({ error: "path is required" }, 400) };
  }
  const path = resolve(raw.path);
  if (!isWithinBasePath(path)) {
    return { error: c.json({ error: "path outside allowed directory" }, 403) };
  }
  const list = parseRoots(typeof raw.roots === "string" ? raw.roots : (raw.roots ?? []).join(","));
  const searchRoots = list.length > 0 ? list : [resolve(getBasePath())];
  for (const r of searchRoots) {
    if (!isWithinBasePath(r)) {
      return { error: c.json({ error: "roots outside allowed directory" }, 403) };
    }
  }
  const line = Number(raw.line);
  const col = Number(raw.col);
  if (!Number.isFinite(line) || line < 1) {
    return { error: c.json({ error: "line must be a 1-based number" }, 400) };
  }
  return {
    body: {
      roots: searchRoots,
      path,
      line,
      col: Number.isFinite(col) && col >= 1 ? col : 1,
      text: typeof raw.text === "string" ? raw.text : undefined,
    },
  };
}

function rootFor(path: string, list: string[]): string {
  return list.find((r) => path === r || path.startsWith(r + sep)) ?? list[0] ?? "";
}

function relative(path: string, root: string): string {
  return root && path.startsWith(root + sep) ? path.slice(root.length + 1) : path;
}

/**
 * Per-request line reader. A definition or reference list points at a handful of
 * files and usually several lines in the same one, so reading each file once is
 * worth a map; keeping that map beyond the request is not.
 */
function lineReader() {
  const cache = new Map<string, string[]>();
  return async (path: string): Promise<string[]> => {
    const hit = cache.get(path);
    if (hit) return hit;
    try {
      const split = (await readFile(path, "utf-8")).split("\n");
      cache.set(path, split);
      return split;
    } catch {
      cache.set(path, []);
      return [];
    }
  };
}

function identifierAt(line: string, col: number): string {
  const start = Math.max(0, col - 1);
  const before = line.slice(0, start).match(/[\w$]+$/)?.[0] ?? "";
  const after = line.slice(start).match(/^[\w$]+/)?.[0] ?? "";
  return (before + after).trim();
}

// POST /api/code/definition  { path, line, col, roots?, text? }
app.post("/definition", async (c) => {
  const { body, error } = await positionBody(c);
  if (error || !body) return error!;

  const lines = lineReader();
  // Never make the first click wait for a monorepo to finish indexing. The LSP
  // request keeps warming in the background and this response reports that
  // state after a short interaction budget.
  const locations = await lsp.definition(body, 350);
  if (locations === undefined) {
    return c.json({
      candidates: [],
      indexed: 0,
      truncated: false,
      source: "warming",
    });
  }
  if (!locations) {
    const name = identifierAt((await lines(body.path))[body.line - 1] ?? "", body.col);
    if (!name) return c.json({ candidates: [], indexed: 0, truncated: false, source: "none" });
    const r = await findDefinitions(body.roots, name, body.path);
    const candidates = r.candidates.filter((x) => isWithinBasePath(x.path));
    return c.json({
      ...r,
      candidates,
      source: "index",
    });
  }

  const candidates = [];
  for (const [index, hit] of locations.entries()) {
    if (!isWithinBasePath(hit.path)) continue;
    const root = rootFor(hit.path, body.roots);
    const text = (await lines(hit.path))[hit.line - 1] ?? "";
    candidates.push({
      // VS Code navigates as soon as definition returns. Asking documentSymbol
      // for cosmetic kind/signature data added another serialized LSP request
      // to every click, and on a cold server it was often the slower request.
      name: identifierAt(text, hit.col) || text.trim().slice(0, 80),
      kind: "definition",
      file: relative(hit.path, root),
      line: hit.line,
      detail: text.trim().slice(0, 200),
      root,
      path: hit.path,
      score: 100 - index,
    });
  }
  return c.json({ candidates, indexed: 0, truncated: false, source: "lsp" });
});

// POST /api/code/references  { path, line, col, roots?, text? }
app.post("/references", async (c) => {
  const { body, error } = await positionBody(c);
  if (error || !body) return error!;

  const lines = lineReader();
  const locations = await lsp.references(body);
  if (!locations) return c.json({ hits: [], truncated: false, source: "none" });

  const hits = [];
  for (const hit of locations) {
    if (!isWithinBasePath(hit.path)) continue;
    const root = rootFor(hit.path, body.roots);
    const text = (await lines(hit.path))[hit.line - 1] ?? "";
    hits.push({
      path: hit.path,
      rel: relative(hit.path, root),
      root,
      line: hit.line,
      col: hit.col,
      text: text.slice(0, 300),
    });
  }
  return c.json({ hits, truncated: false, source: "lsp" });
});

// POST /api/code/hover  { path, line, col, roots?, text? }
app.post("/hover", async (c) => {
  const { body, error } = await positionBody(c);
  if (error || !body) return error!;
  const text = await lsp.hover(body);
  return c.json({ text: text ?? "", source: text ? "lsp" : "none" });
});

// GET /api/code/definition?name=&roots=&from=<abs file the click came from>
//
// Kept for callers that only know a name: search results, and any client that
// has not moved to position-based lookups.
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
    return c.json({
      ...r,
      candidates: r.candidates.filter((x) => isWithinBasePath(x.path)),
      source: "index",
    });
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

  const fromServer = await lsp.documentSymbols({ roots: list, path: abs });
  if (fromServer) {
    const root = rootFor(abs, list);
    return c.json({
      symbols: fromServer.map((s) => ({ ...s, file: relative(abs, root) })),
      source: "lsp",
    });
  }

  const root = list.find((r) => abs === r || abs.startsWith(r + "/"));
  if (!root) return c.json({ symbols: [], source: "none" });

  try {
    const symbols = await documentSymbols(root, abs.slice(root.length + 1));
    return c.json({ symbols, source: "index" });
  } catch (err: any) {
    return c.json({ error: err?.message || "lookup failed" }, 500);
  }
});

// GET /api/code/workspace-symbols?q=&roots=&from=
app.get("/workspace-symbols", async (c) => {
  const query = (c.req.query("q") || "").trim();
  if (!query) return c.json({ symbols: [], source: "none" });
  const { roots: list, error } = roots(c);
  if (error) return error;

  const from = c.req.query("from");
  const symbols = await lsp.workspaceSymbols({
    roots: list,
    query,
    from: from ? resolve(from) : undefined,
  });
  if (!symbols) return c.json({ symbols: [], source: "none" });
  return c.json({
    symbols: symbols.filter((s) => isWithinBasePath(s.path)),
    source: "lsp",
  });
});

// GET /api/code/lsp-status
app.get("/lsp-status", (c) => c.json({ servers: lsp.status() }));

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
