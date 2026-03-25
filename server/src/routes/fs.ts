import { Hono } from "hono";
import { readdir, readFile, stat } from "fs/promises";
import { join, resolve, extname, basename } from "path";


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
 * Get allowed root paths for a session.
 * Returns the worktree/repo paths the session is working in.
 */
async function getAllowedRoots(sessionName: string): Promise<string[]> {
  // Read session worktree metadata from config
  const configDir = process.env.AGENTDOCK_CONFIG_DIR || `${process.env.HOME}/.config/agentdock`;
  const sessionFile = join(configDir, "sessions", sessionName);
  try {
    const { readFileSync } = await import("fs");
    const content = readFileSync(sessionFile, "utf-8").trim();
    // Format: repoPath|wtDir (pipe-delimited, one per line for multi-repo)
    const roots: string[] = [];
    for (const line of content.split("\n")) {
      const parts = line.trim().split("|");
      if (parts.length >= 2 && parts[1]) {
        roots.push(resolve(parts[1]));
      } else if (parts[0]) {
        roots.push(resolve(parts[0]));
      }
    }
    if (roots.length > 0) return roots;
  } catch {
    // session file not found — fall through
  }
  return [];
}

function isWithinRoots(targetPath: string, roots: string[]): boolean {
  const resolved = resolve(targetPath);
  return roots.some((root) => resolved === root || resolved.startsWith(root + "/"));
}

// GET /api/fs/list?path=<abs-path>&session=<name>
app.get("/list", async (c) => {
  const path = c.req.query("path");
  const session = c.req.query("session");

  if (!path || !session) {
    return c.json({ error: "path and session are required" }, 400);
  }

  const resolvedPath = resolve(path);
  const roots = await getAllowedRoots(session);

  if (roots.length === 0) {
    return c.json({ error: "session not found or has no repos" }, 404);
  }

  if (!isWithinRoots(resolvedPath, roots)) {
    return c.json({ error: "path is outside allowed repo roots" }, 403);
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

// GET /api/fs/read?path=<abs-path>&session=<name>
app.get("/read", async (c) => {
  const path = c.req.query("path");
  const session = c.req.query("session");

  if (!path || !session) {
    return c.json({ error: "path and session are required" }, 400);
  }

  const resolvedPath = resolve(path);
  const roots = await getAllowedRoots(session);

  if (roots.length === 0) {
    return c.json({ error: "session not found or has no repos" }, 404);
  }

  if (!isWithinRoots(resolvedPath, roots)) {
    return c.json({ error: "path is outside allowed repo roots" }, 403);
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

export default app;
