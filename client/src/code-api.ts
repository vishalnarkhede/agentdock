const BASE = "";

export interface Candidate {
  name: string;
  kind: string;
  file: string;
  line: number;
  container?: string;
  root: string;
  path: string;
  score: number;
}

export interface DefinitionResult {
  candidates: Candidate[];
  indexed: number;
  truncated: boolean;
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
