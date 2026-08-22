import { describe, test, expect } from "bun:test";
import { searchContent, __test } from "../services/content-search";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { parseLine, gitGrepArgs } = __test;

describe("parseLine", () => {
  const withCol = (raw: string, root = "/repo", rel = true) => parseLine(raw, root, rel, true);
  const noCol = (raw: string, root = "/repo", rel = true) => parseLine(raw, root, rel, false);

  test("parses path:line:col:text from a relative root", () => {
    const m = withCol("src/app.ts:42:7:const x = 1")!;
    expect(m.rel).toBe("src/app.ts");
    expect(m.path).toBe("/repo/src/app.ts");
    expect(m.line).toBe(42);
    expect(m.col).toBe(7);
    expect(m.text).toBe("const x = 1");
  });

  test("keeps colons that belong to the matched text", () => {
    const m = withCol('a.ts:3:1:const url = "http://x.com:8080"')!;
    expect(m.text).toBe('const url = "http://x.com:8080"');
    expect(m.line).toBe(3);
    expect(m.col).toBe(1);
  });

  test("text starting with digits and a colon is not eaten as a column", () => {
    // grep's fallback output has no column field. Guessing here would turn
    // "2024:" into a column number and silently drop it from the text.
    const m = noCol("a.ts:9:2024: a good year")!;
    expect(m.line).toBe(9);
    expect(m.col).toBe(1);
    expect(m.text).toBe("2024: a good year");
  });

  test("with a column field, digits in the text stay in the text", () => {
    const m = withCol("a.ts:9:5:2024: a good year")!;
    expect(m.col).toBe(5);
    expect(m.text).toBe("2024: a good year");
  });

  test("strips the root prefix for absolute output", () => {
    const m = withCol("/repo/src/a.ts:1:1:x", "/repo", false)!;
    expect(m.rel).toBe("src/a.ts");
    expect(m.path).toBe("/repo/src/a.ts");
  });

  test("rejects malformed lines", () => {
    expect(withCol("")).toBeNull();
    expect(withCol("no-colons-here")).toBeNull();
    expect(withCol("only:one")).toBeNull();
    expect(withCol("a.ts:notanumber:1:text")).toBeNull();
    expect(withCol("a.ts:1:notanumber:text")).toBeNull();
  });

  test("truncates a very long line", () => {
    const m = withCol(`a.ts:1:1:${"x".repeat(5000)}`)!;
    expect(m.text.length).toBe(300);
  });
});

describe("gitGrepArgs", () => {
  const base = { roots: [], query: "needle", limit: 10 };

  test("searches untracked files too", () => {
    expect(gitGrepArgs(base as any)).toContain("--untracked");
  });

  test("literal by default, regex on request", () => {
    expect(gitGrepArgs(base as any)).toContain("--fixed-strings");
    expect(gitGrepArgs({ ...base, regex: true } as any)).toContain("--extended-regexp");
  });

  test("case-insensitive by default", () => {
    expect(gitGrepArgs(base as any)).toContain("--ignore-case");
    expect(gitGrepArgs({ ...base, caseSensitive: true } as any)).not.toContain("--ignore-case");
  });

  test("whole-word only when asked", () => {
    expect(gitGrepArgs(base as any)).not.toContain("--word-regexp");
    expect(gitGrepArgs({ ...base, wholeWord: true } as any)).toContain("--word-regexp");
  });

  test("passes the query with -e so a leading dash is not read as a flag", () => {
    const a = gitGrepArgs({ ...base, query: "-oh-no" } as any);
    expect(a[a.indexOf("-e") + 1]).toBe("-oh-no");
  });
});

describe("searchContent against a real repo", () => {
  let dir: string;

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "ad-search-"));
    Bun.spawnSync(["git", "init", "-q", dir]);
    Bun.spawnSync(["git", "-C", dir, "config", "user.email", "t@t.t"]);
    Bun.spawnSync(["git", "-C", dir, "config", "user.name", "t"]);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "tracked.ts"), "const marker = 'UNIQUEMARKER';\nsecond line\n");
    writeFileSync(join(dir, "Makefile"), "build:\n\techo UNIQUEMARKER\n");
    Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
    Bun.spawnSync(["git", "-C", dir, "commit", "-qm", "init"]);
    writeFileSync(join(dir, "src", "untracked.ts"), "const u = 'UNIQUEMARKER';\n");
  };

  test("finds matches in tracked files", async () => {
    setup();
    try {
      const r = await searchContent({ roots: [dir], query: "UNIQUEMARKER", limit: 50 });
      expect(r.matches.length).toBeGreaterThan(0);
      expect(r.matches.some((m) => m.rel === "src/tracked.ts")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds matches in UNTRACKED files — agents create files constantly", async () => {
    setup();
    try {
      const r = await searchContent({ roots: [dir], query: "UNIQUEMARKER", limit: 50 });
      expect(r.matches.some((m) => m.rel === "src/untracked.ts")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds matches in extensionless files the old --include=*.* skipped", async () => {
    setup();
    try {
      const r = await searchContent({ roots: [dir], query: "UNIQUEMARKER", limit: 50 });
      expect(r.matches.some((m) => m.rel === "Makefile")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("respects the limit and reports truncation", async () => {
    setup();
    try {
      const r = await searchContent({ roots: [dir], query: "UNIQUEMARKER", limit: 1 });
      expect(r.matches).toHaveLength(1);
      expect(r.truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("case sensitivity is honoured", async () => {
    setup();
    try {
      const insensitive = await searchContent({ roots: [dir], query: "uniquemarker", limit: 50 });
      expect(insensitive.matches.length).toBeGreaterThan(0);
      const sensitive = await searchContent({ roots: [dir], query: "uniquemarker", limit: 50, caseSensitive: true });
      expect(sensitive.matches).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an aborted search returns rather than hanging", async () => {
    setup();
    try {
      const ac = new AbortController();
      ac.abort();
      const r = await searchContent({ roots: [dir], query: "UNIQUEMARKER", limit: 50, signal: ac.signal });
      expect(Array.isArray(r.matches)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty query does no work", async () => {
    const r = await searchContent({ roots: ["/nonexistent"], query: "", limit: 50 });
    expect(r.matches).toHaveLength(0);
    expect(r.tool).toBe("none");
  });
});
