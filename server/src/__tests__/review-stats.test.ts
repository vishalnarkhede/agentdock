/**
 * Tests for review-stats.ts — the plan's checklist and the diff's numstat.
 *
 * Pure parsing, no filesystem, so it runs without a repo or a session.
 */

import { describe, test, expect } from "bun:test";
import { parsePlanSteps, parseNumstat } from "../services/review-stats";

describe("parsePlanSteps", () => {
  test("reads checked and unchecked items and ignores prose", () => {
    const steps = parsePlanSteps(`
# Fix the index

Some prose that is not a step.

- [x] Read describe_table for moderation_flags
- [ ] Add a partial index on (app_pk, created_at)
* [X] Switch the writer to the time-window lookup
`);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ done: true, text: "Read describe_table for moderation_flags" });
    expect(steps[1].done).toBe(false);
    expect(steps[2].done).toBe(true);
  });

  test("strips inline markdown so text matching is not thrown off by formatting", () => {
    const steps = parsePlanSteps("- [ ] Update `flags/writer.go` and **index.go**");
    expect(steps[0].text).toBe("Update flags/writer.go and index.go");
  });

  test("returns nothing for a plan with no checklist", () => {
    expect(parsePlanSteps("just a paragraph")).toEqual([]);
  });
});

describe("parseNumstat", () => {
  test("parses added and removed counts", () => {
    const files = parseNumstat("142\t38\tmoderation/flags/writer.go\n9\t0\tmigrations/0412.sql\n");
    expect(files).toEqual([
      { path: "moderation/flags/writer.go", plus: 142, minus: 38 },
      { path: "migrations/0412.sql", plus: 9, minus: 0 },
    ]);
  });

  test("treats binary files as zero rather than NaN", () => {
    expect(parseNumstat("-\t-\tassets/logo.png")).toEqual([
      { path: "assets/logo.png", plus: 0, minus: 0 },
    ]);
  });

  test("resolves both rename forms to the new path", () => {
    expect(parseNumstat("1\t1\tolд.go => new.go".replace("olд", "old"))[0].path).toBe("new.go");
    expect(parseNumstat("1\t1\tmoderation/{flags => rules}/spam.go")[0].path)
      .toBe("moderation/rules/spam.go");
  });
});
