/**
 * Tests for fs.ts route — file system list/read endpoints.
 *
 * These tests exercise path traversal protection, binary file rejection,
 * file size limits, and correct directory/file responses.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Use the same config dir set by test-preload.ts (do NOT override AGENTDOCK_CONFIG_DIR)
const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR!;
const SESSIONS_DIR = join(CONFIG_DIR, "sessions");

// Separate temp dir for repo files (not inside config dir)
const TEMP_DIR = join(tmpdir(), `agentdock-fs-repo-${Date.now()}`);
const REPO_DIR = join(TEMP_DIR, "my-repo");

import app from "../routes/fs";

beforeAll(() => {
  // Create fake repo structure
  mkdirSync(join(REPO_DIR, "src"), { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });

  writeFileSync(join(REPO_DIR, "README.md"), "# Hello\nThis is a test.");
  writeFileSync(join(REPO_DIR, "src", "index.ts"), "export const x = 1;");
  writeFileSync(join(REPO_DIR, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // fake PNG

  // Fake large file (600 KB)
  writeFileSync(join(REPO_DIR, "big.txt"), "x".repeat(600 * 1024));

  // Session file in the shared config dir: repoPath|wtDir format
  writeFileSync(join(SESSIONS_DIR, "claude-myrepo"), `${REPO_DIR}|${REPO_DIR}`);
});

afterAll(() => {
  // Only clean up the repo temp dir, not the shared config dir
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

async function request(path: string) {
  const req = new Request(`http://localhost${path}`);
  return app.fetch(req);
}

// ─── /api/fs/list ───

describe("GET /list", () => {
  test("lists directory entries sorted dirs-first", async () => {
    const res = await request(`/list?path=${encodeURIComponent(REPO_DIR)}&session=claude-myrepo`);
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
    const res = await request(`/list?session=claude-myrepo`);
    expect(res.status).toBe(400);
  });

  test("returns 403 for path traversal outside repo", async () => {
    const escaped = encodeURIComponent(join(REPO_DIR, "..", "..", "etc"));
    const res = await request(`/list?path=${escaped}&session=claude-myrepo`);
    expect(res.status).toBe(403);
  });

  test("returns 403 for absolute path outside repo", async () => {
    const res = await request(`/list?path=${encodeURIComponent("/tmp")}&session=claude-myrepo`);
    expect(res.status).toBe(403);
  });

  test("returns 404 for unknown session", async () => {
    const res = await request(`/list?path=${encodeURIComponent(REPO_DIR)}&session=unknown-session`);
    expect(res.status).toBe(404);
  });
});

// ─── /api/fs/read ───

describe("GET /read", () => {
  test("reads a text file and returns content + language", async () => {
    const filePath = join(REPO_DIR, "README.md");
    const res = await request(`/read?path=${encodeURIComponent(filePath)}&session=claude-myrepo`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.content).toContain("Hello");
    expect(data.language).toBe("markdown");
    expect(typeof data.size).toBe("number");
  });

  test("detects typescript language", async () => {
    const filePath = join(REPO_DIR, "src", "index.ts");
    const res = await request(`/read?path=${encodeURIComponent(filePath)}&session=claude-myrepo`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.language).toBe("typescript");
  });

  test("rejects binary files", async () => {
    const filePath = join(REPO_DIR, "image.png");
    const res = await request(`/read?path=${encodeURIComponent(filePath)}&session=claude-myrepo`);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/binary/i);
  });

  test("rejects files larger than 500KB", async () => {
    const filePath = join(REPO_DIR, "big.txt");
    const res = await request(`/read?path=${encodeURIComponent(filePath)}&session=claude-myrepo`);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toMatch(/too large/i);
  });

  test("returns 403 for path traversal", async () => {
    const escaped = encodeURIComponent(join(REPO_DIR, "..", ".bash_profile"));
    const res = await request(`/read?path=${escaped}&session=claude-myrepo`);
    expect(res.status).toBe(403);
  });

  test("returns 400 when path is missing", async () => {
    const res = await request(`/read?session=claude-myrepo`);
    expect(res.status).toBe(400);
  });
});
