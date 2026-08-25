import { describe, expect, it } from "bun:test";
import { comparableRows, paneDiffers, repaintSequence, stripAnsi } from "./terminal-sync";

describe("stripAnsi", () => {
  it("removes colour codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes cursor moves", () => {
    expect(stripAnsi("a\x1b[2Ab\x1b[10;3Hc")).toBe("abc");
  });

  it("removes private modes and OSC titles", () => {
    expect(stripAnsi("\x1b[?25lx\x1b]0;title\x07y")).toBe("xy");
  });

  it("leaves box drawing and other multibyte text alone", () => {
    expect(stripAnsi("╭─╮ ✓ é 🎉")).toBe("╭─╮ ✓ é 🎉");
  });
});

describe("comparableRows", () => {
  it("drops trailing spaces and trailing blank lines", () => {
    expect(comparableRows(["a  ", "b", "", "  ", ""])).toEqual(["a", "b"]);
  });

  it("keeps blank lines that have content after them", () => {
    expect(comparableRows(["a", "", "b"])).toEqual(["a", "", "b"]);
  });
});

describe("paneDiffers", () => {
  it("agrees when the rendered tail matches the pane", () => {
    expect(paneDiffers("one\ntwo\n", ["scroll", "back", "one", "two"])).toBe(false);
  });

  it("ignores colour the capture carries and the buffer does not", () => {
    expect(paneDiffers("\x1b[32mok\x1b[0m\n", ["ok"])).toBe(false);
  });

  it("ignores tmux padding the pane to its full height", () => {
    expect(paneDiffers("one\ntwo\n\n\n\n", ["one", "two"])).toBe(false);
  });

  it("catches a wrong cell", () => {
    expect(paneDiffers("one\ntwo\n", ["one", "tw0"])).toBe(true);
  });

  it("catches a line the screen never got", () => {
    expect(paneDiffers("one\ntwo\nthree\n", ["one", "two"])).toBe(true);
  });

  it("catches mangled multibyte characters", () => {
    expect(paneDiffers("╭───╮\n", ["â•­â•€â•€â•€â•®"])).toBe(true);
  });

  it("says nothing about an empty capture rather than repainting", () => {
    expect(paneDiffers("", ["anything"])).toBe(false);
    expect(paneDiffers("\n\n", ["anything"])).toBe(false);
  });
});

describe("repaintSequence", () => {
  it("homes and erases without resetting, so scrollback survives", () => {
    const out = repaintSequence("a\nb\n", 2, 0, 1);
    expect(out).toContain("\x1b[H\x1b[J");
    expect(out).not.toContain("\x1bc");
  });

  it("drops one trailing newline so the cursor lands on the last row", () => {
    expect(repaintSequence("a\nb\n", 2, 0, 1)).toContain("a\nb\x1b[1G");
  });

  it("counts the cursor up from the bottom of the pane", () => {
    expect(repaintSequence("a\nb\nc\n", 3, 4, 0)).toContain("\x1b[2A\x1b[5G");
  });

  it("omits the move when the cursor is already on the last row", () => {
    expect(repaintSequence("a\nb\n", 2, 2, 1)).not.toContain("A\x1b[");
  });
});
