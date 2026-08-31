const BASE = "";

export interface Candidate {
  name: string;
  kind: string;
  file: string;
  line: number;
  container?: string;
  /** The signature, when a language server supplied one. */
  detail?: string;
  root: string;
  path: string;
  score: number;
}

/** Which layer answered: a language server, the regex index, or nothing. */
export type CodeSource = "lsp" | "index" | "none";

export interface DefinitionResult {
  candidates: Candidate[];
  indexed: number;
  truncated: boolean;
  source?: CodeSource;
}

export interface CodePosition {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  roots: string[];
  /** The unsaved buffer, so a lookup resolves against what is on screen. */
  text?: string;
}

function positionBody(position: CodePosition): string {
  return JSON.stringify({
    path: position.path,
    line: position.line,
    col: position.col,
    roots: position.roots.join(","),
    text: position.text,
  });
}

/**
 * Asks the language server what is under the cursor. The server falls back to
 * the name-based index for languages it has no server for, and says so in
 * `source` so the caller can keep the textual behaviour for those.
 */
export async function findDefinitionAt(
  position: CodePosition,
  signal?: AbortSignal,
): Promise<DefinitionResult> {
  const res = await fetch(`${BASE}/api/code/definition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: positionBody(position),
    signal,
  });
  if (!res.ok) return { candidates: [], indexed: 0, truncated: false, source: "none" };
  return res.json();
}

export interface Reference {
  path: string;
  rel: string;
  root: string;
  line: number;
  col: number;
  text: string;
}

export async function findReferencesAt(
  position: CodePosition,
  signal?: AbortSignal,
): Promise<{ hits: Reference[]; source?: CodeSource }> {
  const res = await fetch(`${BASE}/api/code/references`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: positionBody(position),
    signal,
  });
  if (!res.ok) return { hits: [], source: "none" };
  return res.json();
}

export async function hoverAt(position: CodePosition, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${BASE}/api/code/hover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: positionBody(position),
    signal,
  });
  if (!res.ok) return "";
  return (await res.json()).text ?? "";
}

export interface LanguageServerStatus {
  id: string;
  root: string;
  command: string;
  installed: boolean;
  running: boolean;
  warm: boolean;
  openDocuments: number;
  lastError?: string;
}

export async function fetchLanguageServers(): Promise<LanguageServerStatus[]> {
  const res = await fetch(`${BASE}/api/code/lsp-status`);
  if (!res.ok) return [];
  return (await res.json()).servers ?? [];
}

export async function findDefinition(
  name: string,
  roots: string[],
  from?: string,
  signal?: AbortSignal,
): Promise<DefinitionResult> {
  const qs = new URLSearchParams({ name });
  if (roots.length) qs.set("roots", roots.join(","));
  if (from) qs.set("from", from);
  const res = await fetch(`${BASE}/api/code/definition?${qs}`, { signal });
  if (!res.ok) return { candidates: [], indexed: 0, truncated: false };
  return res.json();
}

export interface DocSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  container?: string;
}

export async function fetchDocSymbols(path: string, roots: string[]): Promise<DocSymbol[]> {
  const qs = new URLSearchParams({ path });
  if (roots.length) qs.set("roots", roots.join(","));
  const res = await fetch(`${BASE}/api/code/symbols?${qs}`);
  if (!res.ok) return [];
  return (await res.json()).symbols ?? [];
}
