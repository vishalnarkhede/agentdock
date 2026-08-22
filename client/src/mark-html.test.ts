import { describe, test, expect } from "bun:test";
import { markHtml, project } from "./mark-html";

const marks = (h: string) => [...h.matchAll(/<mark[^>]*>(.*?)<\/mark>/g)].map((m) => m[1]);

describe("project", () => {
  test("strips tags from the text projection", () => {
    expect(project("<span>abc</span>def").text).toBe("abcdef");
  });
  test("decodes the entities highlight.js emits", () => {
    expect(project("a &amp; b &lt;c&gt; &quot;d&quot;").text).toBe('a & b <c> "d"');
  });
  test("an entity maps back to its full html span", () => {
    const p = project("&amp;x");
    expect(p.text).toBe("&x");
    expect(p.htmlAt[0]).toBe(0);
    expect(p.htmlEndAt[0]).toBe(5);
  });
  test("a bare ampersand is left alone", () => {
    expect(project("a & b").text).toBe("a & b");
  });
  test("runs break at tag boundaries", () => {
    expect(project("<i>ab</i>cd").runs.length).toBe(2);
  });
});

describe("markHtml", () => {
  test("wraps a plain match", () => {
    const r = markHtml("hello world", "world");
    expect(r.count).toBe(1);
    expect(marks(r.html)).toEqual(["world"]);
  });

  test("is case-insensitive but preserves the original casing", () => {
    expect(marks(markHtml("Hello World", "world").html)).toEqual(["World"]);
  });

  test("finds every occurrence", () => {
    const r = markHtml("foo bar foo bar foo", "foo");
    expect(r.count).toBe(3);
  });

  test("never marks inside a tag or attribute", () => {
    // "span" appears in the tag name and the class, but not in the text.
    const r = markHtml('<span class="spanny">text</span>', "span");
    expect(r.count).toBe(0);
    expect(r.html).toBe('<span class="spanny">text</span>');
  });

  test("matches across a highlight span — the case the old DOM walk missed", () => {
    const html = '<span class="hljs-attr">moderation</span>_bodyguard_credentials';
    const r = markHtml(html, "moderation_bodyguard_credentials");
    expect(r.count).toBe(1);
    // one <mark> per run keeps the html well-formed
    expect(marks(r.html)).toEqual(["moderation", "_bodyguard_credentials"]);
    expect(r.html).not.toContain("<mark class=\"fe-match\" data-match=\"0\" data-line=\"1\">moderation</span>");
  });

  test("tags are not broken by the wrapping", () => {
    const r = markHtml("<b>ab</b>cd", "abcd");
    const opens = (r.html.match(/<mark/g) || []).length;
    const closes = (r.html.match(/<\/mark>/g) || []).length;
    expect(opens).toBe(closes);
    expect(r.html).toContain("</b>");
  });

  test("matches text that was entity-encoded", () => {
    const r = markHtml("a &lt;tag&gt; b", "<tag>");
    expect(r.count).toBe(1);
    expect(r.html).toContain("&lt;tag&gt;</mark>");
  });

  test("reports 1-based line numbers", () => {
    const r = markHtml("one\ntwo\nhit here\nfour", "hit");
    expect(r.lines).toEqual([3]);
  });

  test("line numbers for several matches", () => {
    const r = markHtml("x\nx\nx", "x");
    expect(r.lines).toEqual([1, 2, 3]);
  });

  test("newlines inside tags do not shift the line count", () => {
    const r = markHtml("<span\nclass='a'>hit</span>", "hit");
    expect(r.lines).toEqual([1]);
  });

  test("marks the active match distinctly", () => {
    const r = markHtml("aa aa aa", "aa", 1);
    const actives = (r.html.match(/fe-match-active/g) || []).length;
    expect(actives).toBe(1);
    expect(r.html.indexOf("fe-match-active")).toBeGreaterThan(r.html.indexOf('data-match="0"'));
  });

  test("no active class when nothing is active", () => {
    expect(markHtml("aa", "aa").html).not.toContain("fe-match-active");
  });

  test("an empty query is a no-op", () => {
    expect(markHtml("abc", "")).toEqual({ html: "abc", lines: [], count: 0 });
  });

  test("no match leaves the html untouched", () => {
    const html = '<span class="x">abc</span>';
    expect(markHtml(html, "zzz").html).toBe(html);
  });

  test("overlapping candidates do not double-wrap", () => {
    const r = markHtml("aaaa", "aa");
    expect(r.count).toBe(2);
    expect(marks(r.html)).toEqual(["aa", "aa"]);
  });

  test("every match carries its index and line as data attributes", () => {
    const r = markHtml("hit\nhit", "hit");
    expect(r.html).toContain('data-match="0" data-line="1"');
    expect(r.html).toContain('data-match="1" data-line="2"');
  });
});
