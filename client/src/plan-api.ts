const BASE = "";

export interface PlanComment {
  id: string;
  blockId: string;
  anchorText: string;
  body: string;
  createdAt: number;
  resolvedAt?: number;
  sentAt?: number;
  orphaned?: boolean;
}

export interface PlanPayload {
  plan: string | null;
  hash: string;
  unchanged: boolean;
}

export async function fetchPlanDoc(session: string, since?: string): Promise<PlanPayload> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  const res = await fetch(`${BASE}/api/plan/${encodeURIComponent(session)}${qs}`);
  if (!res.ok) throw new Error("failed to load plan");
  const d = await res.json();
  return { plan: d.plan ?? null, hash: d.hash ?? "", unchanged: !!d.unchanged };
}

export async function fetchPlanComments(session: string): Promise<PlanComment[]> {
  const res = await fetch(`${BASE}/api/plan/${encodeURIComponent(session)}/comments`);
  if (!res.ok) return [];
  const d = await res.json();
  return d.comments ?? [];
}

export async function createPlanComment(
  session: string,
  input: { blockId: string; anchorText: string; body: string },
): Promise<PlanComment> {
  const res = await fetch(`${BASE}/api/plan/${encodeURIComponent(session)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("failed to save comment");
  return (await res.json()).comment;
}

export async function patchPlanComment(
  session: string,
  id: string,
  patch: { body?: string; resolved?: boolean; sent?: boolean },
): Promise<PlanComment | null> {
  const res = await fetch(`${BASE}/api/plan/${encodeURIComponent(session)}/comments/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  return (await res.json()).comment;
}

export async function removePlanComment(session: string, id: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/plan/${encodeURIComponent(session)}/comments/${id}`, {
    method: "DELETE",
  });
  return res.ok;
}
