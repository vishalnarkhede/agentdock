import { describe, expect, test } from "bun:test";
import { firstMatchFrom, matchOffsets, stepMatch } from "./text-matches";

describe("matchOffsets", () => {
  test("finds every occurrence, whatever its case", () => {
    expect(matchOffsets("Foo foo FOO", "foo")).toEqual([0, 4, 8]);
  });

  test("does not let matches overlap", () => {
    expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]);
  });

  test("an empty term matches nothing rather than everything", () => {
    expect(matchOffsets("anything", "")).toEqual([]);
  });

  test("stops at the limit instead of decorating a whole file", () => {
    expect(matchOffsets("a".repeat(100), "a", 10)).toHaveLength(10);
  });

  test("a term that is not there", () => {
    expect(matchOffsets("hello", "world")).toEqual([]);
  });
});

describe("firstMatchFrom", () => {
  test("the match you are on, or the next one along", () => {
    expect(firstMatchFrom([5, 40, 90], 40)).toBe(1);
    expect(firstMatchFrom([5, 40, 90], 41)).toBe(2);
    expect(firstMatchFrom([5, 40, 90], 0)).toBe(0);
  });

  test("nothing left below where you are", () => {
    expect(firstMatchFrom([5, 40], 91)).toBeNull();
    expect(firstMatchFrom([], 0)).toBeNull();
  });
});

describe("stepMatch", () => {
  test("walks forward and back through the matches", () => {
    expect(stepMatch(0, 1, 3)).toBe(1);
    expect(stepMatch(1, -1, 3)).toBe(0);
  });

  test("wraps round at both ends", () => {
    expect(stepMatch(2, 1, 3)).toBe(0);
    expect(stepMatch(0, -1, 3)).toBe(2);
  });

  test("no matches, nowhere to step", () => {
    expect(stepMatch(0, 1, 0)).toBe(0);
  });
});
