/**
 * Tests for fs.ts route — file system list/read/search endpoints.
 *
 * These tests exercise path traversal protection, binary file rejection,
 * file size limits, and correct directory/file responses.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Separate temp dir for repo files
const TEMP_DIR = join(tmpdir(), `agentdock-fs-repo-${Date.now()}`);
const REPO_DIR = join(TEMP_DIR, "my-repo");
const EXTERNAL_DIR = join(tmpdir(), `agentdock-fs-external-${Date.now()}`);

// Point base path to TEMP_DIR so path validation passes
process.env.AGENTDOCK_BASE_PATH = TEMP_DIR;

import app from "../routes/fs";

beforeAll(() => {
  mkdirSync(join(REPO_DIR, "src"), { recursive: true });
  mkdirSync(EXTERNAL_DIR, { recursive: true });
  writeFileSync(join(REPO_DIR, "README.md"), "# Hello\nThis is a test.");
  writeFileSync(join(REPO_DIR, "src", "index.ts"), "export const x = 1;");
  writeFileSync(join(REPO_DIR, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(REPO_DIR, "big.txt"), "x".repeat(600 * 1024));
  writeFileSync(join(EXTERNAL_DIR, "notes.md"), "# Outside\nReference material.");
  writeFileSync(join(EXTERNAL_DIR, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(EXTERNAL_DIR, "big.txt"), "x".repeat(600 * 1024));
});

afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
  rmSync(EXTERNAL_DIR, { recursive: true, force: true });
  delete process.env.AGENTDOCK_BASE_PATH;
});

async function request(path: string) {
  const req = new Request(`http://localhost${path}`);
  return app.fetch(req);
}

async function openPath(path: string) {
  return app.fetch(new Request("http://localhost/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }));
}

const roots = encodeURIComponent(REPO_DIR);

// ─── /api/fs/list ───

describe("GET /list", () => {
  test("lists directory entries sorted dirs-first", async () => {
    const res = await request(`/list?path=${encodeURIComponent(REPO_DIR)}&roots=${roots}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(Array.isArray(data.entries)).toBe(true);
    const names = data.entries.map((e: any) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    // dirs come before files
    const srcIdx = names.indexOf("src");
    const readmeIdx = names.indexOf("README.md");
    expect(srcIdx).toBeLessThan(readmeIdx);
  });

  test("returns 400 when path is missing", async () => {
    const res = await request(`/list?roots=${roots}`);
    expect(res.status).toBe(400);
  });

  test("returns 403 for path traversal outside base path", async () => {
    const escaped = encodeURIComponent("/etc/passwd");
    const res = await request(`/list?path=${escaped}&roots=${roots}`);
    expect(res.status).toBe(403);
  });

  test("returns 403 for path outside session roots", async () => {
    // Path is within base path but not within provided roots
    const outsidePath = encodeURIComponent(TEMP_DIR);
    const res = await request(`/list?path=${outsidePath}&roots=${roots}`);
    expect(res.status).toBe(403);
  });
});

// ─── /api/fs/read ───

describe("GET /read", () => {
  test("reads a text file and returns content + language", async () => {
    const filePath = join(REPO_DIR, "README.md");
    const res = await request(`/read?path=${encodeURIComponent(filePath)}&roots=${roots}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.content).toContain("Hello");
    expect(data.language).toBe("markdown");
    expect(typeof data.size).toBe("number");
  });

  test("detects typescript language", async () => {
    const filePath = join(REPO_DIR, "src", "index.ts");
    const res = await request(`/read?path=${encodeURIComponent(filePath)}&roots=${roots}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.language).toBe("typescript");
  });

  test("rejects binary files", async () => {
    const filePath = join(REPO_DIR, "image.png");
    const res = await request(`/read?path=${encodeURIComponent(filePath)}&roots=${roots}`);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/binary/i);
  });

  test("rejects files larger than 500KB", async () => {
    const filePath = join(REPO_DIR, "big.txt");
    const res = await request(`/read?path=${encodeURIComponent(filePath)}&roots=${roots}`);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/too large/i);
  });

  test("returns 403 for path traversal outside base path", async () => {
    const escaped = encodeURIComponent("/etc/passwd");
    const res = await request(`/read?path=${escaped}&roots=${roots}`);
    expect(res.status).toBe(403);
  });

  test("returns 400 when path is missing", async () => {
    const res = await request(`/read?roots=${roots}`);
    expect(res.status).toBe(400);
  });
});

// ─── /api/fs/open ───

describe("POST /open", () => {
  test("opens one absolute text file outside the configured base path", async () => {
    const filePath = join(EXTERNAL_DIR, "notes.md");
    const res = await openPath(filePath);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.path).toBe(filePath);
    expect(data.content).toContain("Reference material");
    expect(data.language).toBe("markdown");
    expect(data.readOnly).toBe(true);
  });

  test("requires an explicitly entered full path", async () => {
    const res = await openPath("notes.md");
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/full path/i);
  });

  test("rejects directories, binary files and oversized files", async () => {
    const directory = await openPath(EXTERNAL_DIR);
    const binary = await openPath(join(EXTERNAL_DIR, "image.png"));
    const large = await openPath(join(EXTERNAL_DIR, "big.txt"));
    expect(directory.status).toBe(400);
    expect(binary.status).toBe(400);
    expect(large.status).toBe(400);
  });

  test("returns a useful error for a missing file", async () => {
    const res = await openPath(join(EXTERNAL_DIR, "missing.txt"));
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe("file not found");
  });
});

// ─── /api/fs/search ───

describe("GET /search", () => {
  test("finds files by name", async () => {
    const res = await request(`/search?q=README&roots=${roots}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results.some((r: any) => r.name === "README.md")).toBe(true);
  });

  test("returns empty results for no match", async () => {
    const res = await request(`/search?q=zzznomatch&roots=${roots}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(0);
  });

  test("returns empty results for empty query", async () => {
    const res = await request(`/search?q=&roots=${roots}`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.results).toHaveLength(0);
  });

  test("returns 403 for roots outside base path", async () => {
    const badRoot = encodeURIComponent("/etc");
    const res = await request(`/search?q=passwd&roots=${badRoot}`);
    expect(res.status).toBe(403);
  });
});
