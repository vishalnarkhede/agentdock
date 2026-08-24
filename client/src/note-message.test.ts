import { describe, expect, it } from "bun:test";
import { buildNoteMessage, noteWhere, NOTE_MAX_LINES } from "./note-message";

describe("noteWhere", () => {
  it("names a single line without a range", () => {
    expect(noteWhere("src/api.ts", 12, 12)).toBe("src/api.ts:12");
  });

  it("names a range", () => {
    expect(noteWhere("src/api.ts", 12, 20)).toBe("src/api.ts:12-20");
  });
});

describe("buildNoteMessage", () => {
  const base = {
    path: "server/src/routes/ws.ts",
    startLine: 55,
    endLine: 57,
    code: "const snap = await capturePaneSnapshot(name);\nif (snap.ok) {\n  send(snap);",
    note: "can this reuse the control client?",
    language: "typescript",
  };

  it("leads with the path and range, then the code, then the note", () => {
    const out = buildNoteMessage(base).split("\n");
    expect(out[0]).toBe("In server/src/routes/ws.ts:55-57");
    expect(out[1]).toBe("```typescript");
    expect(out[2]).toBe("const snap = await capturePaneSnapshot(name);");
    expect(out[out.length - 2]).toBe("```");
    expect(out[out.length - 1]).toBe("can this reuse the control client?");
  });

  it("fences without a language when the file has none", () => {
    expect(buildNoteMessage({ ...base, language: undefined }).split("\n")[1]).toBe("```");
  });

  it("trims a selection too long to be a pointer, and says so", () => {
    const code = Array.from({ length: NOTE_MAX_LINES + 40 }, (_, i) => `line ${i}`).join("\n");
    const out = buildNoteMessage({ ...base, code });
    expect(out).toContain("… (selection trimmed)");
    expect(out.split("\n").filter((l) => l.startsWith("line ")).length).toBe(NOTE_MAX_LINES);
  });

  it("leaves a selection inside the cap untouched", () => {
    expect(buildNoteMessage(base)).not.toContain("selection trimmed");
  });

  it("trims whitespace around the note but not inside the code", () => {
    const out = buildNoteMessage({ ...base, code: "  indented();", note: "  fix this  \n" });
    expect(out).toContain("  indented();");
    expect(out.endsWith("fix this")).toBe(true);
  });
});
