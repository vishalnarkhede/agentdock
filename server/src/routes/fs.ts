import { Hono } from "hono";
import { readdir, readFile, stat } from "fs/promises";
import { join, resolve, extname, basename } from "path";
import { getBasePath } from "../services/config";

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
    });
  } catch (err: any) {
    return c.json({ error: err.message || "failed to read file" }, 500);
  }
});

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".cache", ".parcel-cache", "vendor", "target",
  ".turbo", "coverage", ".nyc_output",
]);

/**
 * Match a file/dir against the search query.
 * Supports path-aware queries like "types/moderation.go":
 *   - Split query by "/" into parts
 *   - Each part must appear as a substring in the relative path, in order
 *   - e.g. "types/mod" matches "services/types/moderation.go"
 */
function matchesQuery(relativePath: string, parts: string[]): boolean {
  const lower = relativePath.toLowerCase();
  let pos = 0;
  for (const part of parts) {
    const idx = lower.indexOf(part, pos);
    if (idx === -1) return false;
    pos = idx + part.length;
  }
  return true;
}

async function searchFiles(
  dir: string,
  root: string,
  parts: string[],
  results: Array<{ path: string; name: string; type: "file" | "dir" }>,
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (results.length >= maxResults) return;
    const fullPath = join(dir, name);
    let s;
    try {
      s = await stat(fullPath);
    } catch {
      continue;
    }
    const isDir = s.isDirectory();
    if (isDir && SKIP_DIRS.has(name)) continue;
    // Compute relative path from search root for path-aware matching
    const relativePath = fullPath.slice(root.length + 1);
    if (matchesQuery(relativePath, parts)) {
      results.push({ path: fullPath, name, type: isDir ? "dir" : "file" });
    }
    if (isDir) {
      await searchFiles(fullPath, root, parts, results, maxResults);
    }
  }
}

// GET /api/fs/search?q=<query>&roots=<comma-separated-abs-paths>
app.get("/search", async (c) => {
  const q = c.req.query("q");
  const rootsParam = c.req.query("roots");

  if (!q || q.length < 1) {
    return c.json({ results: [] });
  }

  const roots = parseRoots(rootsParam);
  const searchRoots = roots.length > 0 ? roots : [resolve(getBasePath())];

  // Validate all roots are within base path
  for (const root of searchRoots) {
    if (!isWithinBasePath(root)) {
      return c.json({ error: "roots outside allowed directory" }, 403);
    }
  }

  // Split query by "/" so "types/moderation.go" matches path segments in order
  const parts = q.toLowerCase().split("/").map((p) => p.trim()).filter(Boolean);

  const results: Array<{ path: string; name: string; type: "file" | "dir" }> = [];
  for (const root of searchRoots) {
    await searchFiles(root, root, parts, results, 100);
    if (results.length >= 100) break;
  }

  return c.json({ results });
});

interface GrepMatch {
  path: string;
  name: string;
  lineNumber: number;
  line: string;
}

/**
 * Search file contents using ripgrep (fast) with grep -r fallback.
 * Returns up to maxMatches results across all roots.
 * Per-file match limit keeps any single file from dominating results.
 */
async function grepContent(roots: string[], query: string, maxMatches: number): Promise<GrepMatch[]> {
  const SKIP_GLOBS = ["!node_modules", "!.git", "!dist", "!build", "!.next", "!vendor", "!target", "!coverage", "!*.min.js", "!*.map"];

  // Try ripgrep first (much faster than grep -r)
  const rgArgs = [
    "--no-heading", "-n",
    "--max-count=5",       // max 5 matches per file
    "--max-columns=300",   // truncate very long lines
    "--fixed-strings",     // literal match, not regex
    "--ignore-case",
    ...SKIP_GLOBS.map((g) => ["--glob", g]).flat(),
    query,
    ...roots,
  ];

  let rawOutput = "";
  let usedTool = "";

  try {
    const proc = Bun.spawn(["rg", ...rgArgs], { stdout: "pipe", stderr: "pipe" });
    rawOutput = await new Response(proc.stdout).text();
    usedTool = "rg";
  } catch {
    // rg not installed — fall back to grep
    try {
      const grepArgs = ["-r", "-n", "-i", "--include=*.*", "-m", "200", query, ...roots];
      const proc = Bun.spawn(["grep", ...grepArgs], { stdout: "pipe", stderr: "pipe" });
      rawOutput = await new Response(proc.stdout).text();
      usedTool = "grep";
    } catch {
      return [];
    }
  }

  const results: GrepMatch[] = [];
  for (const rawLine of rawOutput.split("\n")) {
    if (results.length >= maxMatches) break;
    if (!rawLine.trim()) continue;

    // Format: /abs/path/to/file:linenum:content
    // Find first two colons that separate path, line number, content
    const first = rawLine.indexOf(":");
    if (first === -1) continue;
    // On Windows there would be drive letter colons, but this runs on macOS/Linux
    const second = rawLine.indexOf(":", first + 1);
    if (second === -1) continue;

    const filePath = resolve(rawLine.slice(0, first));
    const lineNumber = parseInt(rawLine.slice(first + 1, second), 10);
    const line = rawLine.slice(second + 1);
    if (!filePath || isNaN(lineNumber)) continue;
    if (!isWithinBasePath(filePath)) continue;

    results.push({ path: filePath, name: basename(filePath), lineNumber, line });
  }

  // Sort by path so results are grouped by file
  results.sort((a, b) => a.path.localeCompare(b.path) || a.lineNumber - b.lineNumber);
  return results;
}

// GET /api/fs/grep?q=<query>&roots=<comma-separated-abs-paths>
app.get("/grep", async (c) => {
  const q = c.req.query("q");
  const rootsParam = c.req.query("roots");

  if (!q || q.trim().length < 2) {
    return c.json({ results: [] });
  }

  const roots = parseRoots(rootsParam);
  const searchRoots = roots.length > 0 ? roots : [resolve(getBasePath())];

  for (const root of searchRoots) {
    if (!isWithinBasePath(root)) {
      return c.json({ error: "roots outside allowed directory" }, 403);
    }
  }

  const results = await grepContent(searchRoots, q.trim(), 200);
  return c.json({ results });
});

export default app;
