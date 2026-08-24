import { describe, expect, it } from "bun:test";
import { queueSections } from "./queue";

const row = (name: string, section?: string) => ({ name, section });

describe("queueSections", () => {
  it("returns null without a grouping", () => {
    expect(queueSections([row("a", "x")], undefined)).toBeNull();
    expect(queueSections([row("a", "x")], [])).toBeNull();
  });

  it("keeps the grouping's order, not the rows' order", () => {
    const out = queueSections([row("a", "eBay"), row("b", "Acme")], ["Acme", "eBay"]);
    expect(out?.map((s) => s.label)).toEqual(["Acme", "eBay"]);
  });

  it("keeps the caller's order inside a section", () => {
    const out = queueSections([row("a", "Acme"), row("b", "Acme")], ["Acme"]);
    expect(out?.[0]!.rows.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("drops sections that filtering emptied", () => {
    const out = queueSections([row("a", "Acme")], ["Acme", "eBay"]);
    expect(out?.map((s) => s.label)).toEqual(["Acme"]);
  });

  it("does not lose a row whose section is missing from the order", () => {
    const out = queueSections([row("a", "Acme"), row("b", "Later")], ["Acme"]);
    expect(out?.map((s) => s.label)).toEqual(["Acme", "Later"]);
  });

  it("skips rows with no section at all", () => {
    const out = queueSections([row("a"), row("b", "Acme")], ["Acme"]);
    expect(out?.length).toBe(1);
    expect(out?.[0]!.rows.map((r) => r.name)).toEqual(["b"]);
  });
});
