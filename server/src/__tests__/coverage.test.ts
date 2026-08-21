/**
 * Tests for coverage.ts — mapping a plan to the diff it produced.
 *
 * Pure logic, no filesystem, so it runs without a repo or a session.
 */

import { describe, test, expect } from "bun:test";
import {
  parsePlanSteps,
  parseNumstat,
  buildCoverage,
  REVIEW_LINE_THRESHOLD,
} from "../services/coverage";

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

describe("buildCoverage", () => {
  const plan = `
- [x] Read describe_table for moderation_flags
- [x] Add a partial index on (app_pk, created_at) in index.go
- [x] Switch the writer to the time-window lookup
- [ ] Backfill check on frankfurt:c4 staging
`;
  const changed = [
    { path: "moderation/flags/index.go", plus: 61, minus: 4 },
    { path: "moderation/flags/writer.go", plus: 142, minus: 38 },
    { path: "moderation/rules/spam.go", plus: 47, minus: 31 },
  ];

  test("attributes files to the step that names them", () => {
    const cov = buildCoverage(plan, changed);
    const byPath = (p: string) => cov.files.find((f) => f.path === p)!;
    expect(cov.steps[byPath("moderation/flags/index.go").step!].text).toContain("index.go");
    expect(cov.steps[byPath("moderation/flags/writer.go").step!].text).toContain("writer");
  });

  test("flags files no step mentions — the case nothing else catches", () => {
    const cov = buildCoverage(plan, changed);
    expect(byUnplanned(cov)).toEqual(["moderation/rules/spam.go"]);
    expect(cov.stats.filesUnplanned).toBe(1);
    expect(cov.stats.filesMapped).toBe(2);
  });

  test("separates an investigation step from a genuinely skipped one", () => {
    const cov = buildCoverage(plan, changed);
    // "Read describe_table..." produced no code, and was never meant to.
    expect(cov.steps[0].state).toBe("investigated");
    // "Backfill check..." produced no code and is a real gap.
    expect(cov.steps[3].state).toBe("gap");
    expect(cov.stats.stepsGap).toBe(1);
  });

  test("marks a diff oversized past the review threshold", () => {
    const small = buildCoverage(plan, [{ path: "a.go", plus: 10, minus: 5 }]);
    expect(small.oversized).toBe(false);
    expect(small.stats.linesChanged).toBe(15);

    const big = buildCoverage(plan, [
      { path: "a.go", plus: REVIEW_LINE_THRESHOLD, minus: 1 },
    ]);
    expect(big.oversized).toBe(true);
  });

  test("a missing plan leaves every file unplanned rather than crashing", () => {
    const cov = buildCoverage(null, changed);
    expect(cov.steps).toEqual([]);
    expect(cov.stats.filesUnplanned).toBe(3);
    expect(cov.files.every((f) => f.step === null)).toBe(true);
  });

  test("generic words in a step do not capture unrelated files", () => {
    // "tests" is a stop word, so it must not vacuum up every _test.go file.
    const cov = buildCoverage("- [ ] Update the tests\n", [
      { path: "moderation/flags/writer_test.go", plus: 5, minus: 0 },
    ]);
    expect(cov.files[0].step).toBeNull();
  });
});

function byUnplanned(cov: ReturnType<typeof buildCoverage>): string[] {
  return cov.files.filter((f) => f.step === null).map((f) => f.path);
}
