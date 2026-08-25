import { describe, test, expect } from "bun:test";
import { score, isSubsequence, rank } from "../services/fuzzy";

const s = (q: string, t: string) => score(q, t)?.score ?? -Infinity;

/** Rank a set of paths and return them best-first. */
function order(query: string, paths: string[]): string[] {
  return rank(query, paths, (p) => p, (p) => p.toLowerCase(), paths.length).map((r) => r.item);
}

describe("isSubsequence", () => {
  test("accepts a scattered subsequence", () => {
    expect(isSubsequence("fx", "src/file/x.ts")).toBe(true);
  });
  test("rejects out-of-order characters", () => {
    expect(isSubsequence("xf", "aaafaaaxaaa".replace("x", "").concat("f"))).toBe(false);
  });
  test("rejects a query longer than the target", () => {
    expect(isSubsequence("abcdef", "abc")).toBe(false);
  });
  test("an empty query matches anything", () => {
    expect(isSubsequence("", "anything")).toBe(true);
  });
});

describe("score", () => {
  test("returns null when the query is not a subsequence", () => {
    expect(score("zzz", "src/app.ts")).toBeNull();
  });

  test("positions point at the matched characters", () => {
    const r = score("app", "src/app.ts");
    expect(r).not.toBeNull();
    expect(r!.positions.map((i) => "src/app.ts"[i]).join("")).toBe("app");
  });

  test("positions are strictly increasing", () => {
    const r = score("stat", "server/src/services/status.ts")!;
    for (let i = 1; i < r.positions.length; i++) {
      expect(r.positions[i]).toBeGreaterThan(r.positions[i - 1]);
    }
  });

  test("finds the best alignment, not the first greedy one", () => {
    // The greedy first 'f' is in "src/f...", but "FileX" is the better answer.
    const r = score("fx", "src/fun/FileX.ts")!;
    const matched = r.positions.map((i) => "src/fun/FileX.ts"[i]).join("");
    expect(matched.toLowerCase()).toBe("fx");
    expect(r.positions[0]).toBe("src/fun/FileX.ts".indexOf("FileX"));
  });
});

describe("ranking", () => {
  test("basename match beats a directory match", () => {
    expect(s("config", "server/src/config.ts")).toBeGreaterThan(
      s("config", "config/server/src/thing.ts"),
    );
  });

  test("exact basename wins outright", () => {
    const ranked = order("status", [
      "server/src/services/status-line-parser.ts",
      "server/src/services/status.ts",
      "client/src/statusbar/widget.ts",
    ]);
    expect(ranked[0]).toBe("server/src/services/status.ts");
  });

  test("consecutive characters beat scattered ones", () => {
    expect(s("sess", "src/session.ts")).toBeGreaterThan(s("sess", "s/e/s/s/other.ts"));
  });

  test("segment-boundary matches rank above mid-word matches", () => {
    expect(s("sm", "src/session-manager.ts")).toBeGreaterThan(s("sm", "src/awesome.ts"));
  });

  test("camelCase humps are boundaries", () => {
    expect(s("fe", "src/FileExplorer.tsx")).toBeGreaterThan(s("fe", "src/unrelated/before.ts"));
  });

  test("shorter path wins an otherwise equal tie", () => {
    expect(s("app", "src/app.ts")).toBeGreaterThan(s("app", "src/very/deeply/nested/app.ts"));
  });

  test("path-segmented query ranks the real path first", () => {
    const ranked = order("types/mod", [
      "client/src/types/moderation.go",
      "server/types.ts",
      "a/typewriter/s/model.go",
    ]);
    expect(ranked[0]).toBe("client/src/types/moderation.go");
  });

  test("a prefix query prefers the file that starts with it", () => {
    const ranked = order("dash", [
      "client/src/pages/Dashboard.tsx",
      "client/src/old-dashboard-shim.ts",
    ]);
    expect(ranked[0]).toBe("client/src/pages/Dashboard.tsx");
  });

  test("case-insensitive", () => {
    expect(score("DASH", "src/Dashboard.tsx")).not.toBeNull();
    expect(score("dash", "src/DASHBOARD.TSX")).not.toBeNull();
  });
});

describe("rank", () => {
  const paths = [
    "server/src/services/session-manager.ts",
    "server/src/services/status.ts",
    "client/src/pages/Dashboard.tsx",
    "README.md",
  ];
  const t = (p: string) => p;
  const l = (p: string) => p.toLowerCase();

  test("drops non-matches", () => {
    const out = rank("zzzz", paths, t, l, 10);
    expect(out).toHaveLength(0);
  });

  test("respects the limit", () => {
    const out = rank("s", paths, t, l, 2);
    expect(out).toHaveLength(2);
  });

  test("returns descending scores", () => {
    const out = rank("se", paths, t, l, 10);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });

  test("an empty query returns candidates unscored", () => {
    const out = rank("", paths, t, l, 3);
    expect(out).toHaveLength(3);
    expect(out[0].positions).toEqual([]);
  });
});
