import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  serverSpecs,
  specFor,
  projectRoot,
  definition,
  references,
  documentSymbols,
  hover,
  status,
  shutdownAll,
  __test,
  type ServerSpec,
} from "../services/lsp";

const { toUri, fromUri, normalizeLocations, flattenSymbols } = __test;

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-lsp-"));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  await shutdownAll();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("server selection", () => {
  test("maps an extension to the server that handles it", () => {
    expect(specFor("/x/main.go")?.id).toBe("gopls");
    expect(specFor("/x/App.tsx")?.id).toBe("typescript");
    expect(specFor("/x/app.py")?.id).toBe("pyright");
    expect(specFor("/x/View.swift")?.id).toBe("sourcekit");
  });

  test("a file nothing claims gets no server", () => {
    expect(specFor("/x/notes.md")).toBeNull();
    expect(specFor("/x/Makefile")).toBeNull();
  });

  test("the language id follows the extension, not the server", () => {
    const spec = specFor("/x/App.tsx")!;
    expect(spec.extensions[".tsx"]).toBe("typescriptreact");
    expect(spec.extensions[".js"]).toBe("javascript");
  });

  test("lsp.json replaces a default by id and can disable one", () => {
    const configDir = process.env.AGENTDOCK_CONFIG_DIR!;
    mkdirSync(configDir, { recursive: true });
    const file = join(configDir, "lsp.json");
    const custom: ServerSpec = {
      id: "rust",
      command: ["rust-analyzer"],
      extensions: { ".rs": "rust" },
      rootMarkers: ["Cargo.toml"],
    };
    writeFileSync(file, JSON.stringify({ disabled: ["pyright"], servers: [custom] }));
    try {
      const ids = serverSpecs().map((s) => s.id);
      expect(ids).toContain("rust");
      expect(ids).not.toContain("pyright");
      expect(specFor("/x/main.rs")?.id).toBe("rust");
      expect(specFor("/x/app.py")).toBeNull();
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("a malformed lsp.json is ignored rather than fatal", () => {
    const file = join(process.env.AGENTDOCK_CONFIG_DIR!, "lsp.json");
    writeFileSync(file, "{ not json");
    try {
      expect(serverSpecs().length).toBeGreaterThan(0);
      expect(specFor("/x/main.go")?.id).toBe("gopls");
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("projectRoot", () => {
  const goSpec = (): ServerSpec => specFor("/x/main.go")!;

  test("nested Go modules share one session-root process", () => {
    const root = tempDir();
    writeFileSync(join(root, "go.mod"), "module outer\n");
    mkdirSync(join(root, "svc"), { recursive: true });
    writeFileSync(join(root, "svc", "go.mod"), "module inner\n");
    const file = join(root, "svc", "main.go");
    writeFileSync(file, "package main\n");

    expect(projectRoot(file, goSpec(), [root])).toBe(root);
  });

  test("an explicit go.work narrows the Go workspace", () => {
    const root = tempDir();
    mkdirSync(join(root, "services", "chat"), { recursive: true });
    writeFileSync(join(root, "services", "go.work"), "go 1.21\n");
    writeFileSync(join(root, "services", "chat", "go.mod"), "module chat\n");
    const file = join(root, "services", "chat", "main.go");
    writeFileSync(file, "package main\n");

    expect(projectRoot(file, goSpec(), [root])).toBe(join(root, "services"));
  });

  test("no marker anywhere falls back to the session root", () => {
    const root = tempDir();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    const file = join(root, "a", "b", "main.go");
    writeFileSync(file, "package main\n");

    expect(projectRoot(file, goSpec(), [root])).toBe(root);
  });

  test("the walk stops at the session root", () => {
    // A worktree must not resolve against the checkout it was branched from.
    const parent = tempDir();
    writeFileSync(join(parent, "go.mod"), "module parent\n");
    const worktree = join(parent, "wt");
    mkdirSync(worktree, { recursive: true });
    const file = join(worktree, "main.go");
    writeFileSync(file, "package main\n");

    expect(projectRoot(file, goSpec(), [worktree])).toBe(worktree);
  });

  test("a file outside every root still resolves to something usable", () => {
    const root = tempDir();
    const other = tempDir();
    const file = join(other, "main.go");
    writeFileSync(file, "package main\n");

    expect(projectRoot(file, goSpec(), [root])).toBe(root);
  });
});

describe("uri conversion", () => {
  test("round-trips a path with spaces", () => {
    const path = "/Users/x/my projects/repo/main.go";
    expect(fromUri(toUri(path))).toBe(path);
  });
});

describe("normalizeLocations", () => {
  test("converts a Location to 1-based line and column", () => {
    const out = normalizeLocations([
      { uri: "file:///r/a.go", range: { start: { line: 4, character: 5 }, end: { line: 4, character: 10 } } },
    ]);
    expect(out).toEqual([{ path: "/r/a.go", line: 5, col: 6, endLine: 5, endCol: 11 }]);
  });

  test("accepts a LocationLink, preferring the selection range", () => {
    const out = normalizeLocations([
      {
        targetUri: "file:///r/b.go",
        targetRange: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
        targetSelectionRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 7 } },
      },
    ]);
    expect(out[0].line).toBe(4);
    expect(out[0].col).toBe(3);
  });

  test("accepts a bare object and tolerates nothing", () => {
    const single = normalizeLocations({
      uri: "file:///r/c.go",
      range: { start: { line: 0, character: 0 } },
    });
    expect(single).toHaveLength(1);
    expect(normalizeLocations(null)).toEqual([]);
    expect(normalizeLocations([{ uri: "file:///r/d.go" }])).toEqual([]);
  });
});

describe("flattenSymbols", () => {
  test("children inherit their parent as the container", () => {
    const out: any[] = [];
    flattenSymbols(
      [
        {
          name: "Server",
          kind: 23,
          selectionRange: { start: { line: 2, character: 5 } },
          children: [
            { name: "Serve", kind: 6, selectionRange: { start: { line: 8, character: 1 } } },
          ],
        },
      ],
      undefined,
      out,
    );
    expect(out).toEqual([
      { name: "Server", kind: "struct", line: 3, container: undefined, detail: undefined },
      { name: "Serve", kind: "method", line: 9, container: "Server", detail: undefined },
    ]);
  });

  test("reads the flat SymbolInformation shape too", () => {
    const out: any[] = [];
    flattenSymbols(
      [
        {
          name: "Greet",
          kind: 12,
          containerName: "main",
          location: { uri: "file:///r/a.go", range: { start: { line: 4, character: 5 } } },
        },
      ],
      undefined,
      out,
    );
    expect(out[0]).toMatchObject({ name: "Greet", kind: "func", line: 5, container: "main" });
  });
});

describe("import hop", () => {
  test("recognises the lines worth hopping through", () => {
    const { IMPORT_LINE } = __test;
    expect(IMPORT_LINE.test('import { useSessions } from "../hooks/useSessions";')).toBe(true);
    expect(IMPORT_LINE.test('  import type { Foo } from "./foo";')).toBe(true);
    expect(IMPORT_LINE.test('export { rank } from "./fuzzy";')).toBe(true);
    // A declaration must never be mistaken for an alias, or a same-file jump
    // would take a pointless extra round trip.
    expect(IMPORT_LINE.test("function positionBody(c: any) {")).toBe(false);
    expect(IMPORT_LINE.test("export function rank() {")).toBe(false);
    expect(IMPORT_LINE.test("const importer = 1;")).toBe(false);
  });
});

describe("typescript tsserver resolution", () => {
  test("a workspace with its own typescript is left alone", () => {
    const root = tempDir();
    mkdirSync(join(root, "node_modules", "typescript", "lib"), { recursive: true });
    writeFileSync(join(root, "node_modules", "typescript", "lib", "tsserver.js"), "");
    expect(__test.typescriptLib(root)).toBeNull();
  });

  test("a workspace without one is pointed at the pinned copy", () => {
    // The global typescript may be v7, which ships no tsserver.js at all.
    const lib = __test.typescriptLib(tempDir());
    expect(lib).toContain("typescript/lib/tsserver.js");
  });
});

describe("language-server memory limits", () => {
  test("gopls receives the configured conservative Go heap limit", () => {
    const previous = process.env.AGENTDOCK_GOPLS_MEMORY_LIMIT;
    process.env.AGENTDOCK_GOPLS_MEMORY_LIMIT = "640MiB";
    try {
      expect(__test.serverEnvironment(specFor("/x/main.go")!).GOMEMLIMIT).toBe("640MiB");
    } finally {
      if (previous === undefined) delete process.env.AGENTDOCK_GOPLS_MEMORY_LIMIT;
      else process.env.AGENTDOCK_GOPLS_MEMORY_LIMIT = previous;
    }
  });

  test("Node language servers receive a bounded heap", () => {
    const options = __test.serverEnvironment(specFor("/x/main.ts")!).NODE_OPTIONS;
    expect(options).toContain("--max-old-space-size=512");
  });
});

describe("status", () => {
  test("reports every configured server, running or not", () => {
    const ids = status().map((s) => s.id);
    expect(ids).toContain("gopls");
    expect(status().every((s) => typeof s.installed === "boolean")).toBe(true);
  });
});

/**
 * The real thing, against a two-file module so gopls indexes it in about a
 * second. Skipped rather than failed when the toolchain is absent, because a
 * missing gopls is exactly the case the fallback exists for.
 */
const gopls = Bun.which("gopls", { PATH: __test.searchPath() });
const describeGo = gopls ? describe : describe.skip;

describeGo("gopls", () => {
  function fixture(): { root: string; file: string } {
    const root = tempDir();
    writeFileSync(join(root, "go.mod"), "module example.com/fixture\n\ngo 1.21\n");
    const file = join(root, "main.go");
    writeFileSync(
      file,
      [
        "package main",
        "",
        'import "fmt"',
        "",
        "func Greet(name string) string {",
        '\treturn "hi " + name',
        "}",
        "",
        "func main() {",
        '\tfmt.Println(Greet("world"))',
        "}",
        "",
      ].join("\n"),
    );
    return { root, file };
  }

  test("resolves a call to its declaration", async () => {
    const { root, file } = fixture();
    // The call to Greet sits on line 10; column 14 is inside the identifier.
    const out = await definition({ roots: [root], path: file, line: 10, col: 14 });
    expect(out).not.toBeNull();
    expect(out![0].path).toBe(file);
    expect(out![0].line).toBe(5);
  }, 60_000);

  test("finds the call site from the declaration", async () => {
    const { root, file } = fixture();
    const out = await references({ roots: [root], path: file, line: 5, col: 6 });
    expect(out).not.toBeNull();
    expect(out!.map((r) => r.line)).toContain(10);
  }, 60_000);

  test("lists the file's symbols with kinds", async () => {
    const { root, file } = fixture();
    const out = await documentSymbols({ roots: [root], path: file });
    expect(out).not.toBeNull();
    expect(out!.find((s) => s.name === "Greet")).toMatchObject({ kind: "func", line: 5 });
  }, 60_000);

  test("hover carries the signature", async () => {
    const { root, file } = fixture();
    const out = await hover({ roots: [root], path: file, line: 10, col: 14 });
    expect(out).toContain("func Greet(name string) string");
  }, 60_000);

  test("resolves against an unsaved buffer instead of the file on disk", async () => {
    const { root, file } = fixture();
    // Renaming the declaration only in the buffer moves it two lines down. A
    // lookup that read the disk would answer 5.
    const edited = [
      "package main",
      "",
      'import "fmt"',
      "",
      "// a comment the file on disk does not have",
      "",
      "func Greet(name string) string {",
      '\treturn "hi " + name',
      "}",
      "",
      "func main() {",
      '\tfmt.Println(Greet("world"))',
      "}",
      "",
    ].join("\n");
    const out = await definition({ roots: [root], path: file, line: 12, col: 14, text: edited });
    expect(out).not.toBeNull();
    expect(out![0].line).toBe(7);
  }, 60_000);

  test("a warm instance is reported as running", async () => {
    const { root, file } = fixture();
    await documentSymbols({ roots: [root], path: file });
    const entry = status().find((s) => s.id === "gopls" && s.root === root);
    expect(entry?.running).toBe(true);
    expect(entry?.openDocuments).toBeGreaterThan(0);
  }, 60_000);
});
