import { describe, test, expect } from "bun:test";
import { parsePlan, planProgress, planOutline, normalize, localBlockId } from "./plan-blocks";

describe("parsePlan", () => {
  test("classifies the block kinds a plan actually uses", () => {
    const b = parsePlan("# Title\n\nprose\n\n- [ ] todo\n- [x] done\n\n> note\n\n---\n\n| a | b |");
    expect(b.map((x) => x.kind)).toEqual([
      "heading", "para", "list", "list", "quote", "rule", "table",
    ]);
  });

  test("reads checkbox state", () => {
    const b = parsePlan("- [ ] open\n- [x] closed\n- plain");
    expect(b.map((x) => x.checked)).toEqual([false, true, null]);
  });

  test("records heading level and list depth", () => {
    const b = parsePlan("### Deep\n- top\n  - nested");
    expect(b[0].level).toBe(3);
    expect(b[1].level).toBe(0);
    expect(b[2].level).toBe(1);
  });

  test("content inside a fence is code, and the fences are dropped", () => {
    const b = parsePlan("before\n```\nx = 1\n```\nafter");
    expect(b.map((x) => x.text)).toEqual(["before", "x = 1", "after"]);
    expect(b[1].kind).toBe("code");
  });

  test("ids are stable when a block moves", () => {
    const a = parsePlan("first\nsecond");
    const b = parsePlan("zero\nfirst\nsecond");
    expect(b.find((x) => x.text === "first")!.id).toBe(a.find((x) => x.text === "first")!.id);
  });

  test("ids survive the agent ticking a checkbox", () => {
    const before = parsePlan("- [ ] wire it")[0];
    const after = parsePlan("- [x] wire it")[0];
    expect(after.id).toBe(before.id);
  });

  test("duplicate lines get distinct ids", () => {
    const b = parsePlan("- [ ] retry\n- [ ] retry");
    expect(b[0].id).not.toBe(b[1].id);
  });

  test("different steps stay distinct", () => {
    const b = parsePlan("- [ ] wire the endpoint\n- [ ] wire the client");
    expect(b[0].id).not.toBe(b[1].id);
  });

  test("blank lines produce no blocks", () => {
    expect(parsePlan("\n\n\n")).toEqual([]);
  });

  test("line numbers point back at the source", () => {
    const b = parsePlan("a\n\nb");
    expect(b[0].line).toBe(0);
    expect(b[1].line).toBe(2);
  });
});

describe("planProgress", () => {
  test("counts only checkbox items", () => {
    expect(planProgress(parsePlan("# T\n- [x] a\n- [ ] b\n- plain\nprose"))).toEqual({ done: 1, total: 2 });
  });
  test("is zero when the plan has no checkboxes", () => {
    expect(planProgress(parsePlan("just prose"))).toEqual({ done: 0, total: 0 });
  });
});

describe("planOutline", () => {
  test("returns headings down to level 3", () => {
    const o = planOutline(parsePlan("# a\n## b\n### c\n#### d\nprose"));
    expect(o.map((x) => x.text)).toEqual(["# a", "## b", "### c"]);
  });
});

describe("normalize", () => {
  test("ignores list markers, checkbox state and whitespace", () => {
    expect(normalize("- [ ]  Wire   the endpoint")).toBe(normalize("1. [x] wire the endpoint"));
  });
  test("keeps genuinely different text apart", () => {
    expect(normalize("- [ ] a")).not.toBe(normalize("- [ ] b"));
  });
});

describe("localBlockId", () => {
  test("occurrence disambiguates", () => {
    expect(localBlockId("same", 0)).not.toBe(localBlockId("same", 1));
  });
});
