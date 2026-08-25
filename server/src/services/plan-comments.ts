import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "";
const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR || join(HOME, ".config", "agentdock");
const PLANS_DIR = join(CONFIG_DIR, "plans");

export interface PlanComment {
  id: string;
  /** Stable id of the block the comment was attached to. */
  blockId: string;
  /** The text that was commented on, used to re-find the block after a rewrite. */
  anchorText: string;
  body: string;
  createdAt: number;
  resolvedAt?: number;
  sentAt?: number;
  /** True when anchorText no longer appears in the plan. */
  orphaned?: boolean;
}

export function hashText(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/**
 * A block's identity is its content, not its position. The agent rewrites the
 * plan file on every step, so an index-based id points at different text a
 * minute later.
 */
export function blockIdFor(text: string): string {
  return hashText(normalize(text));
}

/**
 * Identity of a block, ignoring what the agent routinely changes about it.
 *
 * Leading list markers and checkbox state are stripped: the agent rewrites
 * `- [ ] wire the endpoint` to `- [x] wire the endpoint` on every completed
 * step, and a comment on that step should survive it being done.
 */
export function normalize(s: string): string {
  return s
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX~/-]\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function commentsFile(sessionName: string): string {
  return join(PLANS_DIR, `${sessionName}.comments.json`);
}

export function readComments(sessionName: string): PlanComment[] {
  const f = commentsFile(sessionName);
  if (!existsSync(f)) return [];
  try {
    const parsed = JSON.parse(readFileSync(f, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter(isComment) : [];
  } catch {
    return [];
  }
}

function isComment(c: any): c is PlanComment {
  return c && typeof c.id === "string" && typeof c.body === "string";
}

export function writeComments(sessionName: string, comments: PlanComment[]): void {
  if (!existsSync(PLANS_DIR)) mkdirSync(PLANS_DIR, { recursive: true });
  writeFileSync(commentsFile(sessionName), JSON.stringify(comments, null, 2));
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `pc-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function addComment(
  sessionName: string,
  input: { blockId: string; anchorText: string; body: string },
): PlanComment {
  const comment: PlanComment = {
    id: newId(),
    blockId: input.blockId,
    anchorText: input.anchorText,
    body: input.body,
    createdAt: Date.now(),
  };
  const all = readComments(sessionName);
  all.push(comment);
  writeComments(sessionName, all);
  return comment;
}

export function updateComment(
  sessionName: string,
  id: string,
  patch: { body?: string; resolved?: boolean; sent?: boolean },
): PlanComment | null {
  const all = readComments(sessionName);
  const c = all.find((x) => x.id === id);
  if (!c) return null;
  if (patch.body !== undefined) c.body = patch.body;
  if (patch.resolved !== undefined) c.resolvedAt = patch.resolved ? Date.now() : undefined;
  if (patch.sent !== undefined) c.sentAt = patch.sent ? Date.now() : undefined;
  writeComments(sessionName, all);
  return c;
}

export function deleteComment(sessionName: string, id: string): boolean {
  const all = readComments(sessionName);
  const next = all.filter((x) => x.id !== id);
  if (next.length === all.length) return false;
  writeComments(sessionName, next);
  return true;
}

export function deleteAllComments(sessionName: string): void {
  const f = commentsFile(sessionName);
  if (existsSync(f)) {
    try { unlinkSync(f); } catch { /* already gone */ }
  }
}

/**
 * Split a plan into addressable blocks: paragraphs, headings and list items.
 * Kept deliberately simple — it must agree with what the client renders, and
 * a full markdown parse on the server would be a second source of truth.
 */
export function planBlocks(plan: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const seen = new Map<string, number>();
  for (const raw of plan.split("\n")) {
    const text = raw.trim();
    if (!text) continue;
    if (/^(```|~~~)/.test(text)) continue;
    let id = blockIdFor(text);
    // Two identical lines are two blocks; disambiguate by occurrence.
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}:${n}`;
    out.push({ id, text });
  }
  return out;
}

/**
 * Re-attach comments to the current plan.
 *
 * A comment whose block is still present keeps its anchor. One whose text has
 * been rewritten away is marked orphaned rather than silently re-pointed at
 * whatever now occupies that position — the same problem as an outdated review
 * comment on a pull request, and worth showing rather than hiding.
 */
export function reanchor(comments: PlanComment[], plan: string | null): PlanComment[] {
  if (!plan) return comments.map((c) => ({ ...c, orphaned: true }));
  const blocks = planBlocks(plan);
  const byId = new Set(blocks.map((b) => b.id));
  const byText = new Map<string, string>();
  for (const b of blocks) byText.set(normalize(b.text), b.id);

  return comments.map((c) => {
    if (byId.has(c.blockId)) return { ...c, orphaned: false };
    const moved = byText.get(normalize(c.anchorText));
    if (moved) return { ...c, blockId: moved, orphaned: false };
    return { ...c, orphaned: true };
  });
}
