import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const BASE = join(tmpdir(), `agentdock-fswrite-${process.pid}`);
process.env.AGENTDOCK_BASE_PATH = BASE;

const app = (await import("../routes/fs")).default;

const FILE = join(BASE, "repo", "app.ts");

function post(body: unknown) {
  return app.request("/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readVersion(path: string): Promise<string> {
  const res = await app.request(`/read?path=${encodeURIComponent(path)}`);
  return (await res.json()).version;
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(join(BASE, "repo"), { recursive: true });
  writeFileSync(FILE, "original\n");
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

describe("GET /read", () => {
  test("returns a version token alongside the content", async () => {
    const res = await app.request(`/read?path=${encodeURIComponent(FILE)}`);
    const d = await res.json();
    expect(d.content).toBe("original\n");
    expect(typeof d.version).toBe("string");
    expect(d.version.length).toBeGreaterThan(0);
  });

  test("the token changes when the file changes", async () => {
    const a = await readVersion(FILE);
    writeFileSync(FILE, "different\n");
    expect(await readVersion(FILE)).not.toBe(a);
  });
});

describe("POST /write", () => {
  test("saves when the version still matches", async () => {
    const version = await readVersion(FILE);
    const res = await post({ path: FILE, content: "edited\n", version });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(readFileSync(FILE, "utf-8")).toBe("edited\n");
  });

  test("returns a fresh version so a second save works without re-reading", async () => {
    const v1 = await readVersion(FILE);
    const v2 = (await (await post({ path: FILE, content: "one\n", version: v1 })).json()).version;
    const res = await post({ path: FILE, content: "two\n", version: v2 });
    expect(res.status).toBe(200);
    expect(readFileSync(FILE, "utf-8")).toBe("two\n");
  });

  test("refuses when an agent changed the file underneath", async () => {
    const stale = await readVersion(FILE);
    writeFileSync(FILE, "the agent wrote this\n");

    const res = await post({ path: FILE, content: "my edit\n", version: stale });
    expect(res.status).toBe(409);
    const d = await res.json();
    expect(d.conflict).toBe(true);
    expect(d.currentContent).toBe("the agent wrote this\n");
    // the agent's work is still on disk, untouched
    expect(readFileSync(FILE, "utf-8")).toBe("the agent wrote this\n");
  });

  test("force overwrites a conflict, but only when explicitly asked", async () => {
    const stale = await readVersion(FILE);
    writeFileSync(FILE, "the agent wrote this\n");
    const res = await post({ path: FILE, content: "mine wins\n", version: stale, force: true });
    expect(res.status).toBe(200);
    expect(readFileSync(FILE, "utf-8")).toBe("mine wins\n");
  });

  test("leaves no temp file behind", async () => {
    const version = await readVersion(FILE);
    await post({ path: FILE, content: "x\n", version });
    expect(readdirSync(join(BASE, "repo")).filter((f) => f.includes("agentdock-tmp"))).toEqual([]);
  });

  test("rejects a path outside the base directory", async () => {
    const res = await post({ path: "/etc/hosts", content: "nope", version: "x" });
    expect(res.status).toBe(403);
    expect(existsSync("/etc/hosts")).toBe(true);
  });

  test("rejects a traversal attempt", async () => {
    const res = await post({ path: join(BASE, "repo", "..", "..", "escape.txt"), content: "nope", version: "x" });
    expect(res.status).toBe(403);
  });

  test("rejects a path outside the session roots", async () => {
    mkdirSync(join(BASE, "other"), { recursive: true });
    writeFileSync(join(BASE, "other", "x.ts"), "hi");
    const res = await post({
      path: join(BASE, "other", "x.ts"),
      roots: join(BASE, "repo"),
      content: "nope",
      version: "x",
    });
    expect(res.status).toBe(403);
  });

  test("refuses binary extensions", async () => {
    writeFileSync(join(BASE, "repo", "logo.png"), "x");
    const res = await post({ path: join(BASE, "repo", "logo.png"), content: "nope", version: "x" });
    expect(res.status).toBe(400);
  });

  test("refuses content over the size cap", async () => {
    const version = await readVersion(FILE);
    const res = await post({ path: FILE, content: "x".repeat(600 * 1024), version });
    expect(res.status).toBe(400);
    expect(readFileSync(FILE, "utf-8")).toBe("original\n");
  });

  test("requires path and content", async () => {
    expect((await post({ content: "x" })).status).toBe(400);
    expect((await post({ path: FILE })).status).toBe(400);
  });

  test("reports a missing file rather than creating it", async () => {
    const missing = join(BASE, "repo", "nope.ts");
    const res = await post({ path: missing, content: "x", version: "y" });
    expect(res.status).toBe(500);
    expect(existsSync(missing)).toBe(false);
  });

  test("saves without a version when the caller sends none", async () => {
    const res = await post({ path: FILE, content: "unversioned\n" });
    expect(res.status).toBe(200);
    expect(readFileSync(FILE, "utf-8")).toBe("unversioned\n");
  });
});
