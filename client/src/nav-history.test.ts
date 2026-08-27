import { describe, expect, test } from "bun:test";
import {
  EMPTY_HISTORY,
  MAX_SPOTS,
  back,
  canGoBack,
  canGoForward,
  forward,
  markLine,
  visit,
  type NavHistory,
} from "./nav-history";

const spot = (path: string, line = 1, external = false) => ({ path, line, external });

/** Walk a trail of places, oldest first. */
const trail = (...paths: string[]): NavHistory =>
  paths.reduce((history, path) => visit(history, spot(path)), EMPTY_HISTORY);

describe("visit", () => {
  test("the first place opened is where back starts from", () => {
    const history = visit(EMPTY_HISTORY, spot("/a.ts"));
    expect(history.spots).toEqual([spot("/a.ts")]);
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
  });

  test("re-opening the place already on screen is not a move", () => {
    const history = trail("/a.ts");
    expect(visit(history, spot("/a.ts"))).toBe(history);
  });

  test("the same file at a different line is somewhere else", () => {
    const history = visit(trail("/a.ts"), spot("/a.ts", 42));
    expect(history.spots).toEqual([spot("/a.ts"), spot("/a.ts", 42)]);
  });

  test("opening something new from the past drops what came after", () => {
    const stepped = back(trail("/a.ts", "/b.ts", "/c.ts"))!;
    const history = visit(stepped.history, spot("/d.ts"));
    expect(history.spots.map((s) => s.path)).toEqual(["/a.ts", "/b.ts", "/d.ts"]);
    expect(canGoForward(history)).toBe(false);
    expect(back(history)!.spot.path).toBe("/b.ts");
  });

  test("forgets the oldest places rather than growing without end", () => {
    const paths = Array.from({ length: MAX_SPOTS + 5 }, (_, i) => `/f${i}.ts`);
    const history = trail(...paths);
    expect(history.spots).toHaveLength(MAX_SPOTS);
    expect(history.spots[0].path).toBe("/f5.ts");
    expect(history.index).toBe(MAX_SPOTS - 1);
  });
});

describe("markLine", () => {
  test("back returns to the line you were reading, not the one you opened", () => {
    const reading = markLine(trail("/a.ts", "/b.ts"), 120);
    const history = visit(reading, spot("/c.ts"));
    expect(back(history)!.spot).toEqual(spot("/b.ts", 120));
  });

  test("leaves the trail alone when there is nowhere to mark, or nothing to change", () => {
    expect(markLine(EMPTY_HISTORY, 10)).toBe(EMPTY_HISTORY);
    const history = trail("/a.ts");
    expect(markLine(history, 1)).toBe(history);
    expect(markLine(history, Number.NaN)).toBe(history);
    expect(markLine(history, 0)).toBe(history);
  });

  test("marking does not disturb the places already stepped back over", () => {
    const stepped = back(trail("/a.ts", "/b.ts", "/c.ts"))!;
    const history = markLine(stepped.history, 7);
    expect(history.spots.map((s) => s.line)).toEqual([1, 7, 1]);
    expect(forward(history)!.spot.path).toBe("/c.ts");
  });
});

describe("back and forward", () => {
  test("back retraces the trail and forward returns along it", () => {
    const history = trail("/a.ts", "/b.ts", "/c.ts");

    const first = back(history)!;
    expect(first.spot.path).toBe("/b.ts");
    const second = back(first.history)!;
    expect(second.spot.path).toBe("/a.ts");

    expect(back(second.history)).toBeNull();
    expect(forward(second.history)!.spot.path).toBe("/b.ts");
  });

  test("nothing to go back to, and nothing to return to", () => {
    expect(back(EMPTY_HISTORY)).toBeNull();
    expect(forward(EMPTY_HISTORY)).toBeNull();
    expect(forward(trail("/a.ts", "/b.ts"))).toBeNull();
  });

  test("a full-path open is remembered as one, so it reloads that way", () => {
    const history = visit(trail("/repo/a.ts"), spot("/etc/hosts", 1, true));
    expect(back(history)!.spot).toEqual(spot("/repo/a.ts"));
    expect(forward(back(history)!.history)!.spot.external).toBe(true);
  });
});
