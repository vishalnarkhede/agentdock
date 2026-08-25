import { describe, test, expect } from "bun:test";
import { sameComments } from "./components/PlanView";
import type { PlanComment } from "./plan-api";

const c = (over: Partial<PlanComment> = {}): PlanComment => ({
  id: "a", blockId: "b1", anchorText: "t", body: "hello", createdAt: 1, ...over,
});

describe("sameComments — the guard that stops a poll from re-rendering the plan", () => {
  test("identical content compares equal even across separate fetches", () => {
    expect(sameComments([c()], [c()])).toBe(true);
  });
  test("same reference short-circuits", () => {
    const a = [c()];
    expect(sameComments(a, a)).toBe(true);
  });
  test("both empty", () => {
    expect(sameComments([], [])).toBe(true);
  });
  test("a new comment is a change", () => {
    expect(sameComments([c()], [c(), c({ id: "b" })])).toBe(false);
  });
  test("an edited body is a change", () => {
    expect(sameComments([c()], [c({ body: "edited" })])).toBe(false);
  });
  test("resolving is a change", () => {
    expect(sameComments([c()], [c({ resolvedAt: 5 })])).toBe(false);
  });
  test("sending is a change", () => {
    expect(sameComments([c()], [c({ sentAt: 5 })])).toBe(false);
  });
  test("re-anchoring to a different block is a change", () => {
    expect(sameComments([c()], [c({ blockId: "b2" })])).toBe(false);
  });
  test("going orphaned is a change — the badge has to appear", () => {
    expect(sameComments([c()], [c({ orphaned: true })])).toBe(false);
  });
  test("undefined and false orphaned are the same state", () => {
    expect(sameComments([c({ orphaned: undefined })], [c({ orphaned: false })])).toBe(true);
  });
  test("createdAt drift alone does not count", () => {
    expect(sameComments([c({ createdAt: 1 })], [c({ createdAt: 2 })])).toBe(true);
  });
});
