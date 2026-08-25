/**
 * Tests for conflicts.ts — which sessions are about to collide.
 *
 * Pure logic over file lists; nothing here runs git.
 */

import { describe, it, expect } from "bun:test";
import { findConflicts, unionPaths, type Conflict } from "../services/conflicts";

describe("findConflicts", () => {
  it("returns nothing when no two branches share a file", () => {
    expect(
      findConflicts([
        { session: "a", files: ["x.go"] },
        { session: "b", files: ["y.go"] },
      ]),
    ).toEqual([]);
  });

  it("reports the shared files for each overlapping pair", () => {
    const out = findConflicts([
      { session: "a", files: ["shared.go", "a-only.go"] },
      { session: "b", files: ["shared.go"] },
    ]);
    expect(out).toEqual([{ sessions: ["a", "b"], files: ["shared.go"] }]);
  });

  it("orders the most entangled pair first", () => {
    const out = findConflicts([
      { session: "a", files: ["one.go", "two.go", "three.go"] },
      { session: "b", files: ["one.go"] },
      { session: "c", files: ["one.go", "two.go", "three.go"] },
    ]);
    expect(out[0].sessions).toEqual(["a", "c"]);
    expect(out[0].files).toEqual(["one.go", "three.go", "two.go"]);
  });

  it("compares every pair, not just neighbours", () => {
    const out = findConflicts([
      { session: "a", files: ["shared.go"] },
      { session: "b", files: ["unrelated.go"] },
      { session: "c", files: ["shared.go"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sessions).toEqual(["a", "c"]);
  });

  it("never pairs a session with itself", () => {
    const out = findConflicts([
      { session: "a", files: ["x.go"] },
      { session: "a", files: ["x.go"] },
    ]);
    expect(out).toEqual([]);
  });
});

describe("unionPaths", () => {
  it("dedupes and sorts across lists, dropping empties", () => {
    expect(unionPaths(["b.go", "a.go"], ["a.go", ""], ["c.go"])).toEqual([
      "a.go",
      "b.go",
      "c.go",
    ]);
  });

  it("is empty for no input", () => {
    expect(unionPaths()).toEqual([]);
  });
});
