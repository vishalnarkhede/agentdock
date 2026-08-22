import { describe, test, expect } from "bun:test";
import { tokenize } from "./components/PlanInline";

const kinds = (s: string) => tokenize(s).map((t) => t.t);
const texts = (s: string) => tokenize(s).map((t) => t.s);

describe("tokenize", () => {
  test("plain text is one token", () => {
    expect(tokenize("hello world")).toEqual([{ t: "text", s: "hello world" }]);
  });
  test("code spans", () => {
    expect(kinds("run `git grep` now")).toEqual(["text", "code", "text"]);
    expect(texts("run `git grep` now")).toEqual(["run ", "git grep", " now"]);
  });
  test("bold with either marker", () => {
    expect(kinds("a **b** c")).toEqual(["text", "strong", "text"]);
    expect(kinds("a __b__ c")).toEqual(["text", "strong", "text"]);
  });
  test("italic", () => {
    expect(kinds("a *b* c")).toEqual(["text", "em", "text"]);
  });
  test("strikethrough", () => {
    expect(kinds("a ~~b~~ c")).toEqual(["text", "strike", "text"]);
  });
  test("links keep their href", () => {
    const t = tokenize("see [docs](https://x.dev/a)");
    expect(t[1]).toEqual({ t: "link", s: "docs", href: "https://x.dev/a" });
  });
  test("bold inside a code span is left alone", () => {
    expect(texts("`**not bold**`")).toEqual(["**not bold**"]);
  });
  test("several tokens in one line", () => {
    expect(kinds("**a** and `b` and *c*")).toEqual(["strong", "text", "code", "text", "em"]);
  });
  test("an unclosed marker stays literal", () => {
    expect(kinds("a **b")).toEqual(["text"]);
  });
  test("empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
  test("terminates on adversarial input", () => {
    const t = tokenize("*".repeat(400) + "`x`");
    expect(t.length).toBeGreaterThan(0);
  });
});
