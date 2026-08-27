import { describe, expect, test } from "bun:test";
import { TOUCH_LINE_PX, touchScrollLines, wheelScrollLines } from "./terminal-pty";

describe("wheelScrollLines", () => {
  test("a wheel pushed away asks for history, and back for the prompt", () => {
    expect(wheelScrollLines(-48, 0, 40, 16)).toBe(3);
    expect(wheelScrollLines(48, 0, 40, 16)).toBe(-3);
  });

  test("reads the delta in the unit the event reports", () => {
    expect(wheelScrollLines(-3, 1, 40)).toBe(3);
    expect(wheelScrollLines(-1, 2, 30)).toBe(30);
  });

  test("a trackpad's fraction of a line still moves a line", () => {
    expect(wheelScrollLines(-2, 0, 40, 16)).toBe(1);
    expect(wheelScrollLines(2, 0, 40, 16)).toBe(-1);
  });

  test("caps a flicked wheel so one event cannot walk the whole history", () => {
    expect(wheelScrollLines(-10_000, 0, 40, 16)).toBe(40);
    expect(wheelScrollLines(10_000, 0, 40, 16)).toBe(-40);
  });

  test("no movement, and nonsense, ask for nothing", () => {
    expect(wheelScrollLines(0, 0, 40)).toBe(0);
    expect(wheelScrollLines(Number.NaN, 0, 40)).toBe(0);
  });

  test("survives a terminal reporting no rows or no row height", () => {
    expect(wheelScrollLines(-16, 0, 0, 0)).toBe(16);
    expect(wheelScrollLines(-1, 2, 0)).toBe(1);
  });
});

describe("touchScrollLines", () => {
  test("a finger moving up reveals newer output, and down the history", () => {
    expect(touchScrollLines(TOUCH_LINE_PX * 2).lines).toBe(-2);
    expect(touchScrollLines(-TOUCH_LINE_PX * 2).lines).toBe(2);
  });

  test("keeps travel below a line so a slow drag still accumulates", () => {
    const first = touchScrollLines(TOUCH_LINE_PX - 1);
    expect(first.lines).toBe(0);
    expect(first.remainderPx).toBe(TOUCH_LINE_PX - 1);

    const second = touchScrollLines(first.remainderPx + 2);
    expect(second.lines).toBe(-1);
    expect(second.remainderPx).toBe(1);
  });

  test("caps a long swipe", () => {
    expect(touchScrollLines(-10_000).lines).toBe(40);
  });

  test("nonsense asks for nothing", () => {
    expect(touchScrollLines(Number.NaN)).toEqual({ lines: 0, remainderPx: 0 });
  });
});
