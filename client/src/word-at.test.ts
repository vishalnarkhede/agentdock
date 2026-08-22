import { describe, test, expect } from "bun:test";
import { expandWord } from "./word-at";

const w = (t: string, o: number) => expandWord(t, o)?.word ?? null;

describe("expandWord", () => {
  test("selects the identifier the offset sits inside", () => {
    expect(w("const buildAgentCmd = 1", 10)).toBe("buildAgentCmd");
  });
  test("works at the first character", () => {
    expect(w("buildAgentCmd()", 0)).toBe("buildAgentCmd");
  });
  test("works at the last character", () => {
    expect(w("buildAgentCmd()", 12)).toBe("buildAgentCmd");
  });
  test("a click just past the end still selects it", () => {
    expect(w("buildAgentCmd()", 13)).toBe("buildAgentCmd");
  });
  test("underscores and dollars are part of an identifier", () => {
    expect(w("moderation_bodyguard_credentials", 5)).toBe("moderation_bodyguard_credentials");
    expect(w("$scope.x", 2)).toBe("$scope");
  });
  test("a dot separates identifiers", () => {
    expect(w("o.moderation_enabled", 5)).toBe("moderation_enabled");
    expect(w("o.moderation_enabled", 0)).toBe("o");
  });
  test("digits inside a name are kept", () => {
    expect(w("sha256Hash", 3)).toBe("sha256Hash");
  });
  test("a bare number is not an identifier", () => {
    expect(w("x = 12345", 5)).toBeNull();
  });
  test("whitespace yields nothing", () => {
    expect(w("a   b", 2)).toBeNull();
  });
  test("punctuation yields nothing", () => {
    expect(w("a + b", 2)).toBeNull();
  });
  test("empty text", () => {
    expect(w("", 0)).toBeNull();
  });
  test("offset past the end does not throw", () => {
    expect(w("ab", 99)).toBeNull();
  });
  test("reports the span it matched", () => {
    expect(expandWord("foo bar", 5)).toEqual({ word: "bar", start: 4, end: 7 });
  });
});
