import { describe, expect, it } from "bun:test";
import {
  findConflicts,
  unionPaths,
  planMergeOrder,
  isTestFile,
  type Conflict,
  type ShipItem,
} from "../services/triage";

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

describe("planMergeOrder", () => {
  const item = (session: string, files: string[]): ShipItem => ({
    session,
    branch: `wt-${session}`,
    target: "main",
    files,
  });

  it("plans nothing for no branches", () => {
    expect(planMergeOrder([], "serial")).toEqual([]);
  });

  it("puts unentangled branches before entangled ones", () => {
    const conflicts: Conflict[] = [{ sessions: ["b", "c"], files: ["shared.go"] }];
    const steps = planMergeOrder(
      [item("b", ["shared.go"]), item("c", ["shared.go"]), item("a", ["solo.go"])],
      "serial",
      conflicts,
    );
    const merges = steps.filter((s) => s.kind === "merge").map((s) => s.text);
    expect(merges[0]).toContain("wt-a");
  });

  it("marks where a shared file actually has to be resolved", () => {
    const conflicts: Conflict[] = [{ sessions: ["b", "c"], files: ["shared.go"] }];
    const steps = planMergeOrder(
      [item("b", ["shared.go"]), item("c", ["shared.go"])],
      "serial",
      conflicts,
    );
    const notes = steps.map((s) => s.note ?? "");
    expect(notes.some((n) => n.includes("has to be resolved"))).toBe(true);
  });

  it("does not flag resolution when nothing is entangled", () => {
    const steps = planMergeOrder([item("a", ["x.go"]), item("b", ["y.go"])], "serial");
    expect(steps.every((s) => !(s.note ?? "").includes("has to be resolved"))).toBe(true);
  });

  it("integration strategy resolves once, not per branch", () => {
    const steps = planMergeOrder(
      [item("a", ["shared.go"]), item("b", ["shared.go"]), item("c", ["shared.go"])],
      "integration",
    );
    expect(steps.filter((s) => s.kind === "resolve")).toHaveLength(1);
    expect(steps[0].kind).toBe("branch");
    expect(steps.filter((s) => s.kind === "merge")).toHaveLength(4); // 3 in + 1 out
  });

  it("plans only — no step claims to have run git", () => {
    const steps = planMergeOrder([item("a", ["x.go"])], "serial");
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(["merge", "test", "resolve", "branch", "cleanup"]).toContain(s.kind);
    }
  });
});

describe("isTestFile", () => {
  it("recognises the common test conventions", () => {
    expect(isTestFile("pkg/thing_test.go")).toBe(true);
    expect(isTestFile("src/thing.test.ts")).toBe(true);
    expect(isTestFile("tests/test_thing.py")).toBe(true);
  });

  it("does not call ordinary source a test", () => {
    expect(isTestFile("src/latest.go")).toBe(false);
    expect(isTestFile("src/contest.ts")).toBe(false);
  });
});
