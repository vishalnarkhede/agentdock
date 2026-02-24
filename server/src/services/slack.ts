import { getSlackToken } from "./config";

export interface SlackMessage {
  text: string;
  user: string;
  thread: string[];
}

export function parseSlackLink(url: string): { channel: string; ts: string } | null {
  // https://workspace.slack.com/archives/C1234567/p1234567890123456
  const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/i);
  if (!match) return null;
  const channel = match[1];
  const rawTs = match[2];
  // Slack ts format: insert dot before last 6 digits
  const ts = rawTs.slice(0, -6) + "." + rawTs.slice(-6);
  return { channel, ts };
}

async function slackApi(method: string, params: Record<string, string>): Promise<any> {
  const token = getSlackToken();
  if (!token) {
    throw new Error(
      "Slack token not configured. Save your bot token to ~/.config/agentdock/slack-token"
    );
  }

  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API ${method}: ${data.error}`);
  }
  return data;
}

export async function fetchSlackMessage(link: string): Promise<SlackMessage> {
  const parsed = parseSlackLink(link);
  if (!parsed) throw new Error("Invalid Slack message link");

  // Fetch the specific message
  const data = await slackApi("conversations.history", {
    channel: parsed.channel,
    latest: parsed.ts,
    oldest: parsed.ts,
    inclusive: "true",
    limit: "1",
  });

  const message = data.messages?.[0];
  if (!message) throw new Error("Message not found");

  // Fetch thread replies if it's a thread
  const thread: string[] = [];
  if (message.thread_ts) {
    const threadData = await slackApi("conversations.replies", {
      channel: parsed.channel,
      ts: message.thread_ts,
      limit: "20",
    });
    if (threadData.messages) {
      for (const msg of threadData.messages) {
        if (msg.ts !== parsed.ts) {
          thread.push(msg.text);
        }
      }
    }
  }

  return {
    text: message.text,
    user: message.user || "unknown",
    thread,
  };
}
