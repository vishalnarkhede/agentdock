import { Hono } from "hono";
import { readdir, readFile, stat, writeFile, rename } from "fs/promises";
import { createHash } from "crypto";
import { join, resolve, extname, basename, isAbsolute } from "path";
import { homedir } from "os";
import { getBasePath } from "../services/config";
import { getIndex, invalidate } from "../services/file-index";
import { rank } from "../services/fuzzy";
import { searchContent } from "../services/content-search";
import { notifyFileChanged } from "../services/lsp";

const app = new Hono();

const BINARY_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pyc", ".class", ".o",
]);

const MAX_FILE_SIZE = 500 * 1024; // 500 KB

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".c": "c", ".h": "c",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash",
  ".json": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "css", ".less": "css",
  ".md": "markdown", ".mdx": "markdown",
  ".sql": "sql",
  ".graphql": "graphql", ".gql": "graphql",
  ".dockerfile": "dockerfile",
  ".env": "bash",
};

function getLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const base = basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return LANGUAGE_MAP[ext] || "plaintext";
}

/**
 * Validate that a path is within the configured base path (projects dir).
 * This prevents the API from serving files outside the user's project directory.
 */
function isWithinBasePath(targetPath: string): boolean {
  const base = resolve(getBasePath());
  const resolved = resolve(targetPath);
  return resolved === base || resolved.startsWith(base + "/");
}

function isWithinRoots(targetPath: string, roots: string[]): boolean {
  const resolved = resolve(targetPath);
  return roots.some((root) => resolved === root || resolved.startsWith(root + "/"));
}

function parseRoots(rootsParam: string | undefined): string[] {
  if (!rootsParam) return [];
  return rootsParam
    .split(",")
    .map((r) => resolve(r.trim()))
    .filter(Boolean);
}

// GET /api/fs/list?path=<abs-path>&roots=<comma-separated-abs-paths>
app.get("/list", async (c) => {
  const path = c.req.query("path");
  const rootsParam = c.req.query("roots");

  if (!path) {
    return c.json({ error: "path is required" }, 400);
  }

  const resolvedPath = resolve(path);

  // Validate path is within base path (e.g. ~/projects)
  if (!isWithinBasePath(resolvedPath)) {
    return c.json({ error: "path is outside allowed directory" }, 403);
  }

  // If roots are provided, also validate path is within those roots
  if (rootsParam) {
    const roots = parseRoots(rootsParam);
    if (roots.length > 0 && !isWithinRoots(resolvedPath, roots)) {
      return c.json({ error: "path is outside session repo roots" }, 403);
    }
  }

  try {
    const names = await readdir(resolvedPath);
    const filtered = names.filter(
      (n) => !n.startsWith(".") || n === ".env" || n === ".gitignore"
    );

    const entries = await Promise.all(
      filtered.map(async (name) => {
        const fullPath = join(resolvedPath, name);
        const s = await stat(fullPath);
        const isDir = s.isDirectory();
        return {
          name,
          type: isDir ? ("dir" as const) : ("file" as const),
          ext: isDir ? undefined : extname(name).toLowerCase() || undefined,
        };
      })
    );

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return c.json({ entries });
  } catch (err: any) {
    return c.json({ error: err.message || "failed to list directory" }, 500);
  }
});

// GET /api/fs/read?path=<abs-path>&roots=<comma-separated-abs-paths>
app.get("/read", async (c) => {
  const path = c.req.query("path");
  const rootsParam = c.req.query("roots");

  if (!path) {
    return c.json({ error: "path is required" }, 400);
  }

  const resolvedPath = resolve(path);

  if (!isWithinBasePath(resolvedPath)) {
    return c.json({ error: "path is outside allowed directory" }, 403);
  }

  if (rootsParam) {
    const roots = parseRoots(rootsParam);
    if (roots.length > 0 && !isWithinRoots(resolvedPath, roots)) {
      return c.json({ error: "path is outside session repo roots" }, 403);
    }
  }

  const ext = extname(resolvedPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return c.json({ error: "binary files cannot be previewed" }, 400);
  }

  try {
    const info = await stat(resolvedPath);

    if (!info.isFile()) {
      return c.json({ error: "not a file" }, 400);
    }

    if (info.size > MAX_FILE_SIZE) {
      return c.json({ error: `file too large (${Math.round(info.size / 1024)}KB, max 500KB)` }, 400);
    }

    const content = await readFile(resolvedPath, "utf-8");
    return c.json({
      content,
      language: getLanguage(resolvedPath),
      size: info.size,
      version: fileVersion(content, info.mtimeMs),
    });
  } catch (err: any) {
    return c.json({ error: err.message || "failed to read file" }, 500);
  }
});

// POST /api/fs/open { path: <absolute-path> }
//
// This is deliberately separate from /read. The normal endpoint proves a file
// belongs to the active session roots and /write applies the same proof before
// saving. An explicitly entered full path is a one-file, read-only exception:
// it must not silently turn tree browsing, search, or editing into arbitrary
// filesystem access.
app.post("/open", async (c) => {
  const body = await c.req.json().catch(() => null);
  const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
  if (!rawPath) return c.json({ error: "path is required" }, 400);

  const expanded = rawPath === "~"
    ? homedir()
    : rawPath.startsWith("~/")
      ? join(homedir(), rawPath.slice(2))
      : rawPath;
  if (!isAbsolute(expanded)) {
    return c.json({ error: "enter a full path starting with / or ~/" }, 400);
  }

  const resolvedPath = resolve(expanded);
  const ext = extname(resolvedPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return c.json({ error: "binary files cannot be previewed" }, 400);
  }

  try {
    const info = await stat(resolvedPath);
    if (!info.isFile()) return c.json({ error: "not a file" }, 400);
    if (info.size > MAX_FILE_SIZE) {
      return c.json(
        { error: `file too large (${Math.round(info.size / 1024)}KB, max 500KB)` },
        400,
      );
    }

    const content = await readFile(resolvedPath, "utf-8");
    return c.json({
      path: resolvedPath,
      content,
      language: getLanguage(resolvedPath),
      size: info.size,
      version: fileVersion(content, info.mtimeMs),
      readOnly: true,
    });
  } catch (err: any) {
    if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
    if (err?.code === "EACCES") return c.json({ error: "permission denied" }, 403);
    return c.json({ error: err?.message || "failed to read file" }, 500);
  }
});

/**
 * Identifies the exact bytes a client read. Agents write to these worktrees
 * continuously, so a save has to prove it is replacing the content the user
 * actually saw rather than whatever is there now.
 */
function fileVersion(content: string, mtimeMs: number): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16) + "-" + Math.round(mtimeMs);
}

// POST /api/fs/write  { path, roots?, content, version, force? }
app.post("/write", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.path || typeof body.content !== "string") {
    return c.json({ error: "path and content are required" }, 400);
  }

  const resolvedPath = resolve(body.path);
  if (!isWithinBasePath(resolvedPath)) {
    return c.json({ error: "path is outside allowed directory" }, 403);
  }
  if (body.roots) {
    const roots = parseRoots(String(body.roots));
    if (roots.length > 0 && !isWithinRoots(resolvedPath, roots)) {
      return c.json({ error: "path is outside session repo roots" }, 403);
    }
  }
  if (BINARY_EXTENSIONS.has(extname(resolvedPath).toLowerCase())) {
    return c.json({ error: "binary files cannot be edited" }, 400);
  }
  if (Buffer.byteLength(body.content, "utf-8") > MAX_FILE_SIZE) {
    return c.json({ error: "file too large to save (max 500KB)" }, 400);
  }

  try {
    const info = await stat(resolvedPath);
    if (!info.isFile()) return c.json({ error: "not a file" }, 400);

    const current = await readFile(resolvedPath, "utf-8");
    const currentVersion = fileVersion(current, info.mtimeMs);

    if (!body.force && body.version && body.version !== currentVersion) {
      return c.json(
        {
          error: "changed on disk since you opened it",
          conflict: true,
          currentVersion,
          currentContent: current,
        },
        409,
      );
    }

    // Write to a sibling then rename, so a crash mid-write cannot leave the
    // agent looking at a truncated file.
    const tmp = `${resolvedPath}.agentdock-tmp`;
    await writeFile(tmp, body.content, "utf-8");
    await rename(tmp, resolvedPath);

    const after = await stat(resolvedPath);
    // Any language server holding this file is still answering from the text it
    // read when the file was opened.
    void notifyFileChanged(resolvedPath, body.content);
    return c.json({
      ok: true,
      version: fileVersion(body.content, after.mtimeMs),
      size: after.size,
    });
  } catch (err: any) {
    return c.json({ error: err?.message || "failed to save file" }, 500);
  }
});

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function clampLimit(raw: string | undefined, fallback = DEFAULT_LIMIT): number {
  const n = parseInt(raw || "", 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_LIMIT);
}

function resolveRoots(c: any): { roots: string[]; error?: Response } {
  const roots = parseRoots(c.req.query("roots"));
  const searchRoots = roots.length > 0 ? roots : [resolve(getBasePath())];
  for (const root of searchRoots) {
    if (!isWithinBasePath(root)) {
      return { roots: [], error: c.json({ error: "roots outside allowed directory" }, 403) };
    }
  }
  return { roots: searchRoots };
}

interface FileHit {
  path: string;
  rel: string;
  root: string;
  name: string;
  type: "file";
  score: number;
  positions: number[];
}

async function findFiles(
  roots: string[],
  query: string,
  limit: number,
): Promise<{ hits: FileHit[]; truncated: boolean; indexed: number }> {
  const indexes = await Promise.all(roots.map((r) => getIndex(r).catch(() => null)));
  const candidates: { root: string; rel: string; lower: string }[] = [];
  let indexed = 0;

  for (const idx of indexes) {
    if (!idx) continue;
    indexed += idx.count;
    for (let i = 0; i < idx.paths.length; i++) {
      candidates.push({ root: idx.root, rel: idx.paths[i], lower: idx.lower[i] });
    }
  }

  const ranked = rank(
    query,
    candidates,
    (c) => c.rel,
    (c) => c.lower,
    limit,
  );

  const hits: FileHit[] = ranked.map((r) => ({
    path: join(r.item.root, r.item.rel),
    rel: r.item.rel,
    root: r.item.root,
    name: basename(r.item.rel),
    type: "file" as const,
    score: r.score,
    positions: r.positions,
  }));

  return { hits, truncated: hits.length >= limit, indexed };
}

// GET /api/fs/find?q=&roots=&limit=&kind=name|content|both&re=1&case=1&word=1&glob=
app.get("/find", async (c) => {
  const started = Date.now();
  const q = (c.req.query("q") || "").trim();
  const kind = (c.req.query("kind") || "both") as "name" | "content" | "both";
  const limit = clampLimit(c.req.query("limit"));

  const { roots, error } = resolveRoots(c);
  if (error) return error;

  if (!q) {
    return c.json({
      files: [], content: [],
      truncated: { files: false, content: false },
      tookMs: 0, indexed: 0, tool: "none",
    });
  }

  const wantNames = kind !== "content";
  const wantContent = kind !== "name";

  const [names, content] = await Promise.all([
    wantNames
      ? findFiles(roots, q, limit).catch(() => ({ hits: [], truncated: false, indexed: 0 }))
      : Promise.resolve({ hits: [], truncated: false, indexed: 0 }),
    wantContent
      ? searchContent({
          roots,
          query: q,
          limit,
          regex: c.req.query("re") === "1",
          caseSensitive: c.req.query("case") === "1",
          wholeWord: c.req.query("word") === "1",
          glob: c.req.query("glob") || undefined,
          signal: c.req.raw.signal,
        }).catch(() => ({ matches: [], truncated: false, tookMs: 0, tool: "error" }))
      : Promise.resolve({ matches: [], truncated: false, tookMs: 0, tool: "none" }),
  ]);

  const files = names.hits.filter((f) => isWithinBasePath(f.path));
  const matches = content.matches.filter((m) => isWithinBasePath(m.path));

  return c.json({
    files,
    content: matches,
    truncated: { files: names.truncated, content: content.truncated },
    tookMs: Date.now() - started,
    indexed: names.indexed,
    tool: content.tool,
  });
});

// GET /api/fs/index-status?roots=
app.get("/index-status", async (c) => {
  const { roots, error } = resolveRoots(c);
  if (error) return error;
  const out = await Promise.all(
    roots.map(async (root) => {
      const idx = await getIndex(root).catch(() => null);
      return idx
        ? { root, count: idx.count, builtAt: idx.builtAt, isGit: idx.isGit, truncated: idx.truncated }
        : { root, count: 0, builtAt: 0, isGit: false, truncated: false };
    }),
  );
  return c.json({ roots: out });
});

// POST /api/fs/reindex?roots=
app.post("/reindex", async (c) => {
  const { roots, error } = resolveRoots(c);
  if (error) return error;
  for (const root of roots) invalidate(root);
  const out = await Promise.all(
    roots.map(async (root) => {
      const idx = await getIndex(root).catch(() => null);
      return { root, count: idx?.count ?? 0, builtAt: idx?.builtAt ?? 0 };
    }),
  );
  return c.json({ roots: out });
});

// GET /api/fs/search — kept so older clients keep working.
app.get("/search", async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json({ results: [] });
  const { roots, error } = resolveRoots(c);
  if (error) return error;
  const { hits } = await findFiles(roots, q, clampLimit(c.req.query("limit"), 100));
  return c.json({
    results: hits
      .filter((h) => isWithinBasePath(h.path))
      .map((h) => ({ path: h.path, name: h.name, type: h.type })),
  });
});

// GET /api/fs/grep — kept so older clients keep working.
app.get("/grep", async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) return c.json({ results: [] });
  const { roots, error } = resolveRoots(c);
  if (error) return error;
  const r = await searchContent({
    roots,
    query: q,
    limit: clampLimit(c.req.query("limit")),
    signal: c.req.raw.signal,
  });
  return c.json({
    results: r.matches
      .filter((m) => isWithinBasePath(m.path))
      .map((m) => ({ path: m.path, line: m.line, text: m.text })),
  });
});

export default app;
