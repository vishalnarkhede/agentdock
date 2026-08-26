import { describe, expect, test } from "bun:test";
import { TOUCH_WHEEL_STEP_PX, tmuxWheelSequence } from "./terminal-pty";

describe("tmuxWheelSequence", () => {
  test("ignores touch jitter below one wheel step", () => {
    expect(tmuxWheelSequence(TOUCH_WHEEL_STEP_PX - 1, 120, 40)).toBe("");
    expect(tmuxWheelSequence(-(TOUCH_WHEEL_STEP_PX - 1), 120, 40)).toBe("");
  });

  test("finger down emits wheel-up at the pane centre", () => {
    expect(tmuxWheelSequence(-16, 120, 40)).toBe("\x1b[<64;60;20M");
  });

  test("finger up emits one wheel-down report per step", () => {
    expect(tmuxWheelSequence(32, 100, 30)).toBe(
      "\x1b[<65;50;15M\x1b[<65;50;15M",
    );
  });

  test("clamps a large swipe to a bounded burst", () => {
    const input = tmuxWheelSequence(10_000, 80, 24);
    expect(input.match(/\x1b\[<65;40;12M/g)?.length).toBe(10);
  });

  test("rejects non-finite input and keeps coordinates valid", () => {
    expect(tmuxWheelSequence(Number.NaN, 80, 24)).toBe("");
    expect(tmuxWheelSequence(-16, 0, 0)).toBe("\x1b[<64;1;1M");
  });
});
