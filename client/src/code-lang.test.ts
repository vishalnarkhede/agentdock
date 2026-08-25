import { describe, test, expect } from "bun:test";
import { languageIdFor } from "./code-lang";

describe("languageIdFor", () => {
  test("maps the extensions this codebase actually contains", () => {
    expect(languageIdFor("/r/lib/thing.go")).toBe("go");
    expect(languageIdFor("/r/src/App.tsx")).toBe("tsx");
    expect(languageIdFor("/r/src/api.ts")).toBe("typescript");
    expect(languageIdFor("/r/src/old.js")).toBe("javascript");
    expect(languageIdFor("/r/tasks.py")).toBe("python");
    expect(languageIdFor("/r/ci.yml")).toBe("yaml");
    expect(languageIdFor("/r/README.md")).toBe("markdown");
    expect(languageIdFor("/r/schema.sql")).toBe("sql");
  });

  test("is case-insensitive", () => {
    expect(languageIdFor("/r/Thing.GO")).toBe("go");
  });

  test("recognises extensionless files by name", () => {
    expect(languageIdFor("/r/Dockerfile")).toBe("yaml");
    expect(languageIdFor("/r/go.mod")).toBe("go");
  });

  test("uses the last extension, not the first", () => {
    expect(languageIdFor("/r/thing.test.ts")).toBe("typescript");
  });

  test("unknown extensions get no language rather than a wrong one", () => {
    expect(languageIdFor("/r/notes.xyz")).toBeNull();
    expect(languageIdFor("/r/LICENSE")).toBeNull();
  });

  test("a dotfile with no extension is not mistaken for one", () => {
    expect(languageIdFor("/r/.gitignore")).toBeNull();
  });
});
