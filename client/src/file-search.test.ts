import { describe, test, expect } from "bun:test";
import { groupByFile } from "./components/FileSearch";
import type { ContentHit } from "./search-api";

const hit = (rel: string, line: number): ContentHit => ({
  path: `/repo/${rel}`, rel, root: "/repo", line, col: 1, text: "x",
});

describe("groupByFile — one header instead of the path on every line", () => {
  test("collapses consecutive hits in the same file", () => {
    const g = groupByFile([hit("a.md", 1), hit("a.md", 2), hit("a.md", 3)]);
    expect(g).toHaveLength(1);
    expect(g[0].rel).toBe("a.md");
    expect(g[0].hits.map((h) => h.line)).toEqual([1, 2, 3]);
  });

  test("starts a new group when the file changes", () => {
    const g = groupByFile([hit("a.md", 1), hit("b.md", 1), hit("c.md", 1)]);
    expect(g.map((x) => x.rel)).toEqual(["a.md", "b.md", "c.md"]);
  });

  test("preserves server ordering rather than sorting", () => {
    const g = groupByFile([hit("b.md", 1), hit("a.md", 1)]);
    expect(g.map((x) => x.rel)).toEqual(["b.md", "a.md"]);
  });

  test("a file that reappears later becomes a second group, keeping order", () => {
    const g = groupByFile([hit("a.md", 1), hit("b.md", 1), hit("a.md", 9)]);
    expect(g.map((x) => x.rel)).toEqual(["a.md", "b.md", "a.md"]);
  });

  test("no hits, no groups", () => {
    expect(groupByFile([])).toEqual([]);
  });

  test("every hit survives grouping", () => {
    const hits = [hit("a.md", 1), hit("a.md", 2), hit("b.md", 1)];
    const total = groupByFile(hits).reduce((n, g) => n + g.hits.length, 0);
    expect(total).toBe(hits.length);
  });
});
