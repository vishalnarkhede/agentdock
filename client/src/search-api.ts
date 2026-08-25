const BASE = "";

export interface FileHit {
  path: string;
  rel: string;
  root: string;
  name: string;
  type: "file";
  score: number;
  positions: number[];
}

export interface ContentHit {
  path: string;
  rel: string;
  root: string;
  line: number;
  col: number;
  text: string;
}

export interface FindResult {
  files: FileHit[];
  content: ContentHit[];
  truncated: { files: boolean; content: boolean };
  tookMs: number;
  indexed: number;
  tool: string;
}

export interface FindOptions {
  kind?: "name" | "content" | "both";
  limit?: number;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  glob?: string;
  signal?: AbortSignal;
}

export const EMPTY_FIND: FindResult = {
  files: [],
  content: [],
  truncated: { files: false, content: false },
  tookMs: 0,
  indexed: 0,
  tool: "none",
};

export async function find(
  query: string,
  roots: string[],
  opts: FindOptions = {},
): Promise<FindResult> {
  const qs = new URLSearchParams();
  qs.set("q", query);
  if (roots.length > 0) qs.set("roots", roots.join(","));
  if (opts.kind) qs.set("kind", opts.kind);
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.regex) qs.set("re", "1");
  if (opts.caseSensitive) qs.set("case", "1");
  if (opts.wholeWord) qs.set("word", "1");
  if (opts.glob) qs.set("glob", opts.glob);

  const res = await fetch(`${BASE}/api/fs/find?${qs.toString()}`, { signal: opts.signal });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  return res.json();
}

export interface IndexStatus {
  root: string;
  count: number;
  builtAt: number;
  isGit: boolean;
  truncated: boolean;
}

export async function indexStatus(roots: string[]): Promise<IndexStatus[]> {
  const qs = new URLSearchParams();
  if (roots.length > 0) qs.set("roots", roots.join(","));
  const res = await fetch(`${BASE}/api/fs/index-status?${qs.toString()}`);
  if (!res.ok) return [];
  const d = await res.json();
  return d.roots ?? [];
}

export async function reindex(roots: string[]): Promise<void> {
  const qs = new URLSearchParams();
  if (roots.length > 0) qs.set("roots", roots.join(","));
  await fetch(`${BASE}/api/fs/reindex?${qs.toString()}`, { method: "POST" });
}
