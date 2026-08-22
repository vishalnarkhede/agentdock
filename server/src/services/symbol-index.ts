import { stat, readFile } from "fs/promises";
import { join, resolve, extname } from "path";
import { getIndex } from "./file-index";

/**
 * Definition index: where each name is declared.
 *
 * Deliberately name-based rather than type-aware. Measured on the chat
 * monorepo, this costs 1.6s to build and 8 MB to hold, against 5.9 GB and
 * 5–11s per package for gopls. It cannot resolve an overload or an interface
 * implementation, so ambiguous names return every candidate and the caller
 * picks — which is honest, and cheap enough to leave running.
 */

export interface SymbolDef {
  name: string;
  kind: string;
  /** Relative to the root. */
  file: string;
  /** 1-based. */
  line: number;
  /** Receiver or enclosing type, when the language makes it obvious. */
  container?: string;
}

interface FileSymbols {
  mtimeMs: number;
  defs: SymbolDef[];
}

interface RootIndex {
  root: string;
  files: Map<string, FileSymbols>;
  byName: Map<string, SymbolDef[]>;
  builtAt: number;
  count: number;
  scanned: number;
}

const TTL_MS = 60_000;
/** Bounds total memory: each root costs single-digit MB, so a handful is fine. */
const MAX_ROOTS = 6;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 400;
const READ_CONCURRENCY = 24;

const INDEXABLE = new Set([
  ".go", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".java", ".rb", ".kt", ".swift", ".c", ".h", ".cc", ".cpp",
]);

interface Rule {
  re: RegExp;
  kind: string;
  /** Capture group holding a receiver/owner, if the pattern has one. */
  container?: number;
}

const GO: Rule[] = [
  { re: /^func\s+\(\s*\w+\s+\*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)/, kind: "method", container: 1 },
  { re: /^func\s+([A-Za-z_]\w*)/, kind: "func" },
  { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/, kind: "interface" },
  { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/, kind: "struct" },
  { re: /^type\s+([A-Za-z_]\w*)/, kind: "type" },
  { re: /^(?:const|var)\s+([A-Za-z_]\w*)/, kind: "var" },
  { re: /^\s+([A-Z]\w*)\s+[A-Za-z_*\[\]]+\s*(?:`|$|\/\/)/, kind: "field" },
];

const TS: Rule[] = [
  { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { re: /^(?:export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "const" },
];

const PY: Rule[] = [
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "def" },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
];

const GENERIC: Rule[] = [
  { re: /^\s*(?:pub\s+)?(?:fn|func|function)\s+([A-Za-z_]\w*)/, kind: "func" },
  { re: /^\s*(?:public|private|protected|static|final|\s)*class\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
  { re: /^\s*(?:pub\s+)?(?:trait|impl|enum)\s+([A-Za-z_]\w*)/, kind: "type" },
];

export function rulesFor(ext: string): Rule[] {
  if (ext === ".go") return GO;
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return TS;
  if (ext === ".py") return PY;
  return GENERIC;
}

export function extractSymbols(text: string, file: string): SymbolDef[] {
  const ext = extname(file).toLowerCase();
  const rules = rulesFor(ext);
  const out: SymbolDef[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE) continue;
    for (const r of rules) {
      const m = r.re.exec(line);
      if (!m) continue;
      const name = r.container ? m[2] : m[1];
      if (!name) continue;
      const def: SymbolDef = { name, kind: r.kind, file, line: i + 1 };
      if (r.container && m[r.container]) def.container = m[r.container];
      out.push(def);
      break;
    }
  }
  return out;
}

const cache = new Map<string, RootIndex>();
const inflight = new Map<string, Promise<RootIndex>>();

function evictIfNeeded(): void {
  while (cache.size > MAX_ROOTS) {
    let oldest: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of cache) {
      if (v.builtAt < oldestAt) { oldestAt = v.builtAt; oldest = k; }
    }
    if (!oldest) break;
    cache.delete(oldest);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Rebuilds incrementally: only files whose mtime moved are re-read. Agents
 * touch a handful of files at a time, so a refresh costs a stat sweep rather
 * than re-reading the repo.
 */
async function build(root: string, prev?: RootIndex): Promise<RootIndex> {
  const idx = await getIndex(root);
  const files = new Map<string, FileSymbols>();
  let scanned = 0;

  const candidates = idx.paths.filter((p) => INDEXABLE.has(extname(p).toLowerCase()));

  await mapLimit(candidates, READ_CONCURRENCY, async (rel) => {
    const abs = join(root, rel);
    let mtimeMs: number;
    let size: number;
    try {
      const st = await stat(abs);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      return;
    }
    if (size > MAX_FILE_BYTES) return;

    const before = prev?.files.get(rel);
    if (before && before.mtimeMs === mtimeMs) {
      files.set(rel, before);
      return;
    }
    let text: string;
    try {
      text = await readFile(abs, "utf-8");
    } catch {
      return;
    }
    scanned++;
    files.set(rel, { mtimeMs, defs: extractSymbols(text, rel) });
  });

  if (prev && scanned === 0 && files.size === prev.files.size) {
    // Nothing was re-read, so the symbol table is identical. Rebuilding it
    // would allocate a fresh 100k-entry map and discard the old one.
    prev.builtAt = Date.now();
    prev.scanned = 0;
    return prev;
  }

  const byName = new Map<string, SymbolDef[]>();
  let count = 0;
  for (const fs of files.values()) {
    for (const d of fs.defs) {
      const arr = byName.get(d.name);
      if (arr) arr.push(d);
      else byName.set(d.name, [d]);
      count++;
    }
  }

  return { root, files, byName, builtAt: Date.now(), count, scanned };
}

export async function getSymbolIndex(root: string): Promise<RootIndex> {
  const key = resolve(root);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.builtAt < TTL_MS) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = build(key, hit)
    .then((next) => {
      cache.set(key, next);
      evictIfNeeded();
      return next;
    })
    .catch((err) => {
      if (hit) return hit;
      throw err;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

export function invalidateSymbols(root?: string): void {
  if (root) cache.delete(resolve(root));
  else cache.clear();
}

export interface Candidate extends SymbolDef {
  root: string;
  path: string;
  score: number;
}

/**
 * Rank definitions for a name. Nearness wins: the same file, then the same
 * directory, then the same repo. Without types that is the best available
 * signal, and it is right most of the time in a well-organised tree.
 */
export function rankCandidates(
  defs: { def: SymbolDef; root: string }[],
  fromFile: string | undefined,
): Candidate[] {
  const fromDir = fromFile ? fromFile.slice(0, fromFile.lastIndexOf("/")) : undefined;
  const out = defs.map(({ def, root }) => {
    let score = 0;
    const abs = join(root, def.file);
    if (fromFile && abs === fromFile) score += 100;
    if (fromDir) {
      const dir = abs.slice(0, abs.lastIndexOf("/"));
      if (dir === fromDir) score += 40;
      else if (abs.startsWith(fromDir + "/")) score += 15;
    }
    if (def.kind === "method" || def.kind === "func" || def.kind === "function" || def.kind === "def") score += 12;
    if (def.kind === "class" || def.kind === "interface" || def.kind === "struct" || def.kind === "type") score += 10;
    if (def.kind === "field" || def.kind === "var" || def.kind === "const") score += 2;
    if (/^[A-Z]/.test(def.name)) score += 3;
    if (/(^|\/)(vendor|node_modules|third_party|generated)\//.test(def.file)) score -= 50;
    if (/_test\.|\.test\.|\.spec\./.test(def.file)) score -= 8;
    if (/mock/i.test(def.file)) score -= 6;
    return { ...def, root, path: abs, score };
  });
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return out;
}

export async function findDefinitions(
  roots: string[],
  name: string,
  fromFile?: string,
  limit = 50,
): Promise<{ candidates: Candidate[]; indexed: number; truncated: boolean }> {
  const idxs = await Promise.all(roots.map((r) => getSymbolIndex(r).catch(() => null)));
  const hits: { def: SymbolDef; root: string }[] = [];
  let indexed = 0;
  for (const idx of idxs) {
    if (!idx) continue;
    indexed += idx.count;
    for (const d of idx.byName.get(name) ?? []) hits.push({ def: d, root: idx.root });
  }
  const ranked = rankCandidates(hits, fromFile);
  return { candidates: ranked.slice(0, limit), indexed, truncated: ranked.length > limit };
}

export async function documentSymbols(root: string, relFile: string): Promise<SymbolDef[]> {
  const idx = await getSymbolIndex(root);
  return idx.files.get(relFile)?.defs ?? [];
}

export const __test = { build };
