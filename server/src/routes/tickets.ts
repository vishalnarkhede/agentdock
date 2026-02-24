import { Hono } from "hono";
import { fetchTicket, addComment, updateTicket, createTicket, createSubIssue } from "../services/linear";

const app = new Hono();

// Create a new ticket
app.post("/", async (c) => {
  try {
    const { title, description } = await c.req.json<{ title: string; description?: string }>();
    if (!title) return c.json({ error: "title is required" }, 400);
    const ticket = await createTicket(title, description || "");
    return c.json(ticket);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const ticket = await fetchTicket(id);
    if (!ticket) {
      return c.json({ error: `Ticket '${id}' not found` }, 404);
    }
    return c.json(ticket);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Add a comment to a ticket
app.post("/:id/comments", async (c) => {
  const id = c.req.param("id");
  try {
    const { body } = await c.req.json<{ body: string }>();
    if (!body) return c.json({ error: "body is required" }, 400);
    await addComment(id, body);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Create a sub-issue under a ticket
app.post("/:id/subissues", async (c) => {
  const id = c.req.param("id");
  try {
    const { title, description } = await c.req.json<{ title: string; description?: string }>();
    if (!title) return c.json({ error: "title is required" }, 400);
    const ticket = await createSubIssue(id, title, description || "");
    return c.json(ticket);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Update a ticket (description, title, stateId)
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const updates = await c.req.json<{ description?: string; stateId?: string; title?: string }>();
    await updateTicket(id, updates);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
