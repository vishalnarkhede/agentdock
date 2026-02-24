import { Hono } from "hono";
import { fetchSlackMessage } from "../services/slack";
import { createTicket, buildTicketPrompt } from "../services/linear";
import { startSession } from "../services/session-manager";

const app = new Hono();

// POST /api/quick/slack-to-fix
// body: { link: "https://workspace.slack.com/archives/C.../p...", targets?: string[] }
//
// Pipeline:
//   1. Fetch Slack message (+ thread)
//   2. Create Linear ticket from message
//   3. Spawn isolated agent session to fix it
app.post("/slack-to-fix", async (c) => {
  const body = (await c.req.json()) as { link: string; targets?: string[] };

  if (!body.link) {
    return c.json({ error: "link is required" }, 400);
  }

  try {
    // 1. Fetch Slack message
    const msg = await fetchSlackMessage(body.link);

    // Build ticket description from message + thread
    let description = msg.text;
    if (msg.thread.length > 0) {
      description += "\n\n---\nThread:\n";
      description += msg.thread.map((t) => `- ${t}`).join("\n");
    }
    description += `\n\n---\nSource: ${body.link}`;

    // Derive a short title (first line, capped at 100 chars)
    const firstLine = msg.text.split("\n")[0];
    const title =
      firstLine.length > 100 ? firstLine.slice(0, 97) + "..." : firstLine;

    // 2. Create Linear ticket
    const ticket = await createTicket(title, description);

    // 3. Start session with the ticket
    const sessions = await startSession({
      targets: body.targets || [],
      ticket: ticket.identifier,
      name: ticket.identifier.toLowerCase(),
      grouped: true,
      isolated: true,
    });

    return c.json({
      ticket: {
        identifier: ticket.identifier,
        title: ticket.title,
        url: ticket.url,
      },
      sessions,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
