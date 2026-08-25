import { describe, test, expect } from "bun:test";
import { parseTicketId } from "./ticket-id";

describe("parseTicketId", () => {
  test("a bare id passes through, uppercased", () => {
    expect(parseTicketId("MOD2-1289")).toBe("MOD2-1289");
    expect(parseTicketId("mod2-1289")).toBe("MOD2-1289");
    expect(parseTicketId("  MOD-267  ")).toBe("MOD-267");
  });

  test("a pasted Linear URL — the case that broke", () => {
    expect(parseTicketId("https://linear.app/stream/issue/MOD2-1289/prepare-moderation-scalability-benchmarks-for-teleperformance"))
      .toBe("MOD2-1289");
  });

  test("URL variants", () => {
    expect(parseTicketId("https://linear.app/stream/issue/MOD-267")).toBe("MOD-267");
    expect(parseTicketId("linear.app/stream/issue/mod2-1289/slug")).toBe("MOD2-1289");
    expect(parseTicketId("https://linear.app/stream/issue/MOD2-1289/x?foo=1#c")).toBe("MOD2-1289");
  });

  test("a slug containing digits does not win over the real id", () => {
    expect(parseTicketId("https://linear.app/stream/issue/MOD2-1289/fix-bug-123")).toBe("MOD2-1289");
  });

  test("an id embedded in a sentence", () => {
    expect(parseTicketId("please do MOD2-1289 today")).toBe("MOD2-1289");
  });

  test("nothing that looks like an id", () => {
    expect(parseTicketId("")).toBeNull();
    expect(parseTicketId("   ")).toBeNull();
    expect(parseTicketId("just some words")).toBeNull();
    expect(parseTicketId("https://linear.app/stream/team/MOD2/all")).toBeNull();
  });

  test("does not mistake a bare number or a date", () => {
    expect(parseTicketId("1289")).toBeNull();
    expect(parseTicketId("2026-08-24")).toBeNull();
  });
});
