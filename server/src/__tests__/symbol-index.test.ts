import { describe, test, expect } from "bun:test";
import { extractSymbols, rankCandidates, type SymbolDef } from "../services/symbol-index";

const names = (defs: SymbolDef[]) => defs.map((d) => `${d.kind}:${d.name}`);

describe("extractSymbols — Go", () => {
  test("finds funcs, methods, types and interfaces", () => {
    const src = [
      "package moderation",
      "",
      "type Config struct {",
      "\tEnabled bool `json:\"enabled\"`",
      "}",
      "",
      "type Store interface {",
      "\tLoad() error",
      "}",
      "",
      "func New(c Config) *Store { return nil }",
      "",
      "func (s *Store) Load() error { return nil }",
    ].join("\n");
    const got = names(extractSymbols(src, "lib/moderation/store.go"));
    expect(got).toContain("struct:Config");
    expect(got).toContain("interface:Store");
    expect(got).toContain("func:New");
    expect(got).toContain("method:Load");
  });

  test("a method records its receiver", () => {
    const d = extractSymbols("func (s *Store) Load() error {", "a.go")[0];
    expect(d.name).toBe("Load");
    expect(d.container).toBe("Store");
  });

  test("line numbers are 1-based", () => {
    const d = extractSymbols("package x\n\nfunc Hi() {}", "a.go").find((x) => x.name === "Hi")!;
    expect(d.line).toBe(3);
  });
});

describe("extractSymbols — TypeScript", () => {
  test("finds the declaration forms a React codebase uses", () => {
    const src = [
      "export interface Props { a: string }",
      "export type Mode = 'a' | 'b';",
      "export const DEFAULTS = { x: 1 };",
      "export function useThing() {}",
      "export default class Widget {}",
      "export enum Kind { A }",
      "async function loadIt() {}",
    ].join("\n");
    const got = names(extractSymbols(src, "src/x.ts"));
    expect(got).toContain("interface:Props");
    expect(got).toContain("type:Mode");
    expect(got).toContain("const:DEFAULTS");
    expect(got).toContain("function:useThing");
    expect(got).toContain("class:Widget");
    expect(got).toContain("enum:Kind");
    expect(got).toContain("function:loadIt");
  });

  test("a call is not a declaration", () => {
    expect(extractSymbols("useThing();\nfoo(bar);", "src/x.ts")).toEqual([]);
  });
});

describe("extractSymbols — Python", () => {
  test("finds defs and classes, including async and indented", () => {
    const got = names(extractSymbols("class Thing:\n    def run(self):\n    async def go(self):", "a.py"));
    expect(got).toEqual(["class:Thing", "def:run", "def:go"]);
  });
});

describe("extractSymbols — general", () => {
  test("skips absurdly long lines rather than chewing on minified output", () => {
    expect(extractSymbols("func " + "x".repeat(500) + "() {}", "a.go")).toEqual([]);
  });
  test("empty input", () => {
    expect(extractSymbols("", "a.go")).toEqual([]);
  });
  test("one declaration per line at most", () => {
    expect(extractSymbols("func A() {}", "a.go")).toHaveLength(1);
  });
});

describe("rankCandidates", () => {
  const d = (file: string, kind = "func", name = "Load"): SymbolDef => ({ name, kind, file, line: 1 });
  const rank = (files: { def: SymbolDef; root: string }[], from?: string) => rankCandidates(files, from).map((c) => c.file);

  test("a definition in the file you clicked from wins", () => {
    const out = rank([
      { def: d("other/thing.go"), root: "/r" },
      { def: d("here/thing.go"), root: "/r" },
    ], "/r/here/thing.go");
    expect(out[0]).toBe("here/thing.go");
  });

  test("same directory beats elsewhere in the repo", () => {
    const out = rank([
      { def: d("far/away.go"), root: "/r" },
      { def: d("near/other.go"), root: "/r" },
    ], "/r/near/thing.go");
    expect(out[0]).toBe("near/other.go");
  });

  test("the exact same directory beats a subdirectory of it", () => {
    const out = rank([
      { def: d("pkg/sub/deep.go"), root: "/r" },
      { def: d("pkg/sibling.go"), root: "/r" },
    ], "/r/pkg/thing.go");
    expect(out[0]).toBe("pkg/sibling.go");
  });

  test("vendored code sinks to the bottom", () => {
    const out = rank([
      { def: d("vendor/lib/thing.go"), root: "/r" },
      { def: d("lib/thing.go"), root: "/r" },
    ]);
    expect(out[0]).toBe("lib/thing.go");
  });

  test("tests and mocks rank below real source", () => {
    const out = rank([
      { def: d("lib/thing_test.go"), root: "/r" },
      { def: d("lib/thing_mock.go"), root: "/r" },
      { def: d("lib/thing.go"), root: "/r" },
    ]);
    expect(out[0]).toBe("lib/thing.go");
  });

  test("a function outranks a field of the same name", () => {
    const out = rankCandidates([
      { def: d("a.go", "field"), root: "/r" },
      { def: d("b.go", "func"), root: "/r" },
    ], undefined);
    expect(out[0].file).toBe("b.go");
  });

  test("ordering is deterministic when scores tie", () => {
    const input = [{ def: d("b.go"), root: "/r" }, { def: d("a.go"), root: "/r" }];
    expect(rank(input)).toEqual(rank(input));
    expect(rank(input)[0]).toBe("a.go");
  });

  test("candidates carry an absolute path", () => {
    expect(rankCandidates([{ def: d("lib/x.go"), root: "/r" }], undefined)[0].path).toBe("/r/lib/x.go");
  });

  test("no candidates, no crash", () => {
    expect(rankCandidates([], "/r/a.go")).toEqual([]);
  });
});
