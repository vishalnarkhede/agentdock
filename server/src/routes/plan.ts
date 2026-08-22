import { Hono } from "hono";
import { getPlan } from "../services/config";
import {
  addComment,
  deleteComment,
  hashText,
  readComments,
  reanchor,
  updateComment,
} from "../services/plan-comments";

const app = new Hono();

// GET /api/plan/:session?since=<hash>
//
// `since` lets the client poll without paying for a re-render: an unchanged
// plan comes back as {unchanged:true} and the client leaves its state alone.
app.get("/:session", (c) => {
  const session = c.req.param("session");
  const plan = getPlan(session);
  const hash = plan === null ? "" : hashText(plan);
  const since = c.req.query("since");
  if (since && since === hash) {
    return c.json({ unchanged: true, hash });
  }
  return c.json({ plan, hash, unchanged: false });
});

app.get("/:session/comments", (c) => {
  const session = c.req.param("session");
  const plan = getPlan(session);
  return c.json({ comments: reanchor(readComments(session), plan) });
});

app.post("/:session/comments", async (c) => {
  const session = c.req.param("session");
  const body = await c.req.json().catch(() => null);
  if (!body?.body?.trim()) return c.json({ error: "body is required" }, 400);
  if (!body?.blockId) return c.json({ error: "blockId is required" }, 400);
  const comment = addComment(session, {
    blockId: String(body.blockId),
    anchorText: String(body.anchorText ?? ""),
    body: String(body.body).trim(),
  });
  return c.json({ comment });
});

app.patch("/:session/comments/:id", async (c) => {
  const session = c.req.param("session");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const comment = updateComment(session, id, {
    body: typeof body.body === "string" ? body.body : undefined,
    resolved: typeof body.resolved === "boolean" ? body.resolved : undefined,
    sent: typeof body.sent === "boolean" ? body.sent : undefined,
  });
  if (!comment) return c.json({ error: "not found" }, 404);
  return c.json({ comment });
});

app.delete("/:session/comments/:id", (c) => {
  const ok = deleteComment(c.req.param("session"), c.req.param("id"));
  return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

export default app;
