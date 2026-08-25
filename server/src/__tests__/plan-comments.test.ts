import { describe, test, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  addComment, readComments, updateComment, deleteComment, deleteAllComments,
  reanchor, planBlocks, writeComments,
} from "../services/plan-comments";

// test-preload.ts points AGENTDOCK_CONFIG_DIR at a temp dir before any module
// loads. Setting it here instead would leak into every other suite in the run.
const dir = process.env.AGENTDOCK_CONFIG_DIR!;

const SESSION = "claude-test";

beforeEach(() => {
  mkdirSync(join(dir, "plans"), { recursive: true });
  deleteAllComments(SESSION);
});

describe("planBlocks", () => {
  test("addresses paragraphs, headings and list items", () => {
    const b = planBlocks("# Title\n\nSome prose.\n\n- [ ] step one\n- [x] step two\n");
    expect(b.map((x) => x.text)).toEqual([
      "# Title", "Some prose.", "- [ ] step one", "- [x] step two",
    ]);
  });

  test("ids come from content, not position", () => {
    const a = planBlocks("first\nsecond");
    const b = planBlocks("zero\nfirst\nsecond");
    expect(b.find((x) => x.text === "first")!.id).toBe(a.find((x) => x.text === "first")!.id);
  });

  test("two identical lines get distinct ids", () => {
    const b = planBlocks("- [ ] retry\n- [ ] retry");
    expect(b).toHaveLength(2);
    expect(b[0].id).not.toBe(b[1].id);
  });

  test("skips blank lines and fence markers", () => {
    const b = planBlocks("a\n\n```\ncode\n```\n\nb");
    expect(b.map((x) => x.text)).toEqual(["a", "code", "b"]);
  });
});

describe("comment CRUD", () => {
  test("round-trips through the file", () => {
    const c = addComment(SESSION, { blockId: "b1", anchorText: "step one", body: "why?" });
    expect(readComments(SESSION)).toHaveLength(1);
    expect(readComments(SESSION)[0].id).toBe(c.id);
    expect(readComments(SESSION)[0].body).toBe("why?");
  });

  test("updates body, resolved and sent", () => {
    const c = addComment(SESSION, { blockId: "b1", anchorText: "x", body: "a" });
    updateComment(SESSION, c.id, { body: "b" });
    expect(readComments(SESSION)[0].body).toBe("b");
    updateComment(SESSION, c.id, { resolved: true });
    expect(readComments(SESSION)[0].resolvedAt).toBeGreaterThan(0);
    updateComment(SESSION, c.id, { resolved: false });
    expect(readComments(SESSION)[0].resolvedAt).toBeUndefined();
    updateComment(SESSION, c.id, { sent: true });
    expect(readComments(SESSION)[0].sentAt).toBeGreaterThan(0);
  });

  test("updating a missing comment reports it rather than throwing", () => {
    expect(updateComment(SESSION, "nope", { body: "x" })).toBeNull();
  });

  test("deletes", () => {
    const c = addComment(SESSION, { blockId: "b1", anchorText: "x", body: "a" });
    expect(deleteComment(SESSION, c.id)).toBe(true);
    expect(readComments(SESSION)).toHaveLength(0);
    expect(deleteComment(SESSION, c.id)).toBe(false);
  });

  test("survives a reload — this is the whole point of persisting them", () => {
    addComment(SESSION, { blockId: "b1", anchorText: "x", body: "kept" });
    expect(readComments(SESSION)[0].body).toBe("kept");
  });

  test("a corrupt comments file degrades to empty instead of throwing", () => {
    writeFileSync(join(dir, "plans", `${SESSION}.comments.json`), "{not json");
    expect(readComments(SESSION)).toEqual([]);
  });

  test("a non-array comments file degrades to empty", () => {
    writeFileSync(join(dir, "plans", `${SESSION}.comments.json`), '{"a":1}');
    expect(readComments(SESSION)).toEqual([]);
  });

  test("drops malformed entries but keeps good ones", () => {
    writeComments(SESSION, [
      { id: "ok", blockId: "b", anchorText: "t", body: "fine", createdAt: 1 },
      { nonsense: true } as any,
    ]);
    const got = readComments(SESSION);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("ok");
  });
});

describe("reanchor — the agent rewrites the plan constantly", () => {
  const PLAN_V1 = "# Plan\n\n- [ ] wire the endpoint\n- [ ] add tests\n";

  test("a comment on an unchanged block stays anchored", () => {
    const id = planBlocks(PLAN_V1).find((b) => b.text.includes("endpoint"))!.id;
    const c = addComment(SESSION, { blockId: id, anchorText: "- [ ] wire the endpoint", body: "q" });
    const [out] = reanchor([c], PLAN_V1);
    expect(out.orphaned).toBe(false);
    expect(out.blockId).toBe(id);
  });

  test("ticking a checkbox keeps the comment — the agent does this constantly", () => {
    const id = planBlocks(PLAN_V1).find((b) => b.text.includes("endpoint"))!.id;
    const c = addComment(SESSION, { blockId: id, anchorText: "- [ ] wire the endpoint", body: "q" });
    const PLAN_V2 = "# Plan\n\n- [x] wire the endpoint\n- [ ] add tests\n";
    const [out] = reanchor([c], PLAN_V2);
    expect(out.orphaned).toBe(false);
  });

  test("a bullet promoted to a numbered item keeps its comment", () => {
    const id = planBlocks(PLAN_V1).find((b) => b.text.includes("endpoint"))!.id;
    const c = addComment(SESSION, { blockId: id, anchorText: "- [ ] wire the endpoint", body: "q" });
    const RENUMBERED = "# Plan\n\n1. wire the endpoint\n2. add tests\n";
    expect(reanchor([c], RENUMBERED)[0].orphaned).toBe(false);
  });

  test("different steps stay distinct after normalisation", () => {
    const b = planBlocks("- [ ] wire the endpoint\n- [ ] wire the client");
    expect(b[0].id).not.toBe(b[1].id);
  });

  test("a block that only moved keeps its comment", () => {
    const id = planBlocks(PLAN_V1).find((b) => b.text.includes("endpoint"))!.id;
    const c = addComment(SESSION, { blockId: id, anchorText: "- [ ] wire the endpoint", body: "q" });
    const MOVED = "# Plan\n\n- [ ] add tests\n- [ ] wire the endpoint\n";
    const [out] = reanchor([c], MOVED);
    expect(out.orphaned).toBe(false);
  });

  test("text rewritten away is marked orphaned, never re-pointed", () => {
    const c = addComment(SESSION, { blockId: "gone", anchorText: "- [ ] something deleted", body: "q" });
    const [out] = reanchor([c], PLAN_V1);
    expect(out.orphaned).toBe(true);
    expect(out.blockId).toBe("gone");
  });

  test("every comment is orphaned when the plan disappears", () => {
    const c = addComment(SESSION, { blockId: "b", anchorText: "t", body: "q" });
    expect(reanchor([c], null)[0].orphaned).toBe(true);
  });

  test("re-anchoring does not mutate the stored comments", () => {
    const c = addComment(SESSION, { blockId: "gone", anchorText: "vanished", body: "q" });
    reanchor([c], PLAN_V1);
    expect(readComments(SESSION)[0].orphaned).toBeUndefined();
  });
});

describe("isolation", () => {
  test("writes under AGENTDOCK_CONFIG_DIR, never the real config", () => {
    addComment(SESSION, { blockId: "b", anchorText: "t", body: "x" });
    expect(existsSync(join(dir, "plans", `${SESSION}.comments.json`))).toBe(true);
  });
});
