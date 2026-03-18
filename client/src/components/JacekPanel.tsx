import { useState, useRef, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createSession, sendSessionInput, fetchSessionOutput } from "../api";

interface Props {
  visible: boolean;
  onClose: () => void;
}

interface ChatMessage {
  role: "user" | "jacek";
  text: string;
}

const JACEK_NAME = "jacek-overseer";
const JACEK_SESSION = `claude-${JACEK_NAME}`;

const JACEK_PROMPT = `You are Jacek, the project overseer for AgentDock. Your job is to help the user stay organized across all their Claude coding sessions.

You have access to the agentdock MCP server. Use it to:
- Track and summarize PRs across all sessions (register_pr, list_prs)
- Check what each session is working on (list_sessions, get_session_output)
- Read and write shared notes for coordination (add_note, list_notes)

IMPORTANT formatting rules:
- Keep responses SHORT and scannable
- Use markdown: bullet points, bold, tables (keep tables narrow)
- Bold the important parts (status, blockers, action items)
- Never apologize or add filler text
- Do NOT narrate what tools you are calling or what you are doing. Just call the tools silently and present the final result. No "Let me check..." or "Calling list_prs..." — just the answer.
- Do NOT output a [STATUS: ...] line`;

const QUICK_ACTIONS = [
  { label: "Show all PRs", message: "List all tracked PRs grouped by feature. Use a compact list format, not a wide table." },
  { label: "Session status", message: "List all active sessions and what each one is doing right now. Keep it compact." },
  { label: "What's blocked?", message: "Check all sessions for any errors or things that need my input" },
];

// Strip ANSI escape codes including OSC hyperlinks (]8;;url\text]8;;\)
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")       // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (BEL or ST terminated)
    .replace(/\]8;;[^\s]*\s*/g, "")                // Plaintext OSC 8 hyperlink starts (]8;;url)
    .replace(/\]8;;\\/g, "")                        // Plaintext OSC 8 hyperlink ends (]8;;\)
    .replace(/\]8;;\s*/g, "")                       // Any remaining ]8;; fragments
    .replace(/\\#\d+/g, "")                         // \#12147 style fragments
    .replace(/\x1b/g, "");                          // Any remaining escape chars
}

// Check if a line is terminal chrome that should be skipped
function isChrome(line: string): boolean {
  if (!line.trim()) return true;
  // Box-drawing separator lines
  if (/^[\s─━═┌┐└┘├┤┬┴┼│╭╮╰╯╶╴╵╷┄┅┈┉┆┇┊┋╌╍╎╏]+$/.test(line.trim())) return true;
  // Status bar
  if (/^⏵⏵/.test(line.trim())) return true;
  // Bare prompt
  if (line.trim() === "❯") return true;
  // "hold Space to speak", "bypass permissions", "shift+tab" lines
  if (/hold Space|bypass permissions|shift\+tab|ctrl\+o to expand/i.test(line)) return true;
  // "+N lines" collapsed indicator
  if (/^\s*…\s*\+\d+ lines/.test(line)) return true;
  return false;
}

// Check if text looks like MCP tool call noise
function isMcpNoise(text: string): boolean {
  // "agentdock - tool_name (MCP)" header
  if (/^agentdock\s*-\s*\w+.*\(MCP\)$/.test(text.trim())) return true;
  return false;
}

// Parse terminal output into chat messages
function parseOutput(raw: string): ChatMessage[] {
  const clean = stripAnsi(raw);
  const lines = clean.split("\n");
  const messages: ChatMessage[] = [];
  let current: ChatMessage | null = null;
  let skipWelcome = true;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip welcome banner (everything before first ❯)
    if (skipWelcome) {
      if (trimmed.startsWith("❯")) skipWelcome = false;
      else continue;
    }

    if (isChrome(line)) continue;

    // User message — always single line, don't append continuations
    if (trimmed.startsWith("❯ ")) {
      const text = trimmed.slice(2).trim();
      if (text.startsWith("Read and follow")) continue;
      if (text === "/clear") continue;
      if (current) messages.push(current);
      // Push immediately — user messages are always one line
      messages.push({ role: "user", text });
      current = null;
      continue;
    }

    // Jacek response (⏺ prefix)
    if (trimmed.startsWith("⏺")) {
      const text = trimmed.slice(1).trim();
      // Skip file read lines and MCP tool call headers
      if (text.startsWith("Read ") && text.includes("file")) continue;
      if (isMcpNoise(text)) continue;

      if (current?.role === "jacek") {
        current.text += "\n" + text;
      } else {
        if (current) messages.push(current);
        current = { role: "jacek", text };
      }
      continue;
    }

    // ⎿ lines — MCP results / tool output — skip all of them
    if (trimmed.startsWith("⎿")) continue;

    // Continuation line — append to current message if it's not junk
    if (current) {
      // Skip JSON fragments and lines that look like JSON data
      if (/^\s*[{[\]}"']/.test(trimmed) && /[{}\[\],:]/.test(trimmed) && trimmed.length < 80) continue;
      if (/^\s*"[\w_]+":\s/.test(trimmed)) continue;
      // Skip broken table borders
      if (/^[│┌┐└┘├┤┬┴┼─]+/.test(trimmed) && trimmed.includes("─")) continue;
      // Skip "(ctrl+o to expand)" hints
      if (/ctrl\+o to expand/.test(trimmed)) continue;

      current.text += "\n" + trimmed;
    }
  }

  if (current) messages.push(current);

  // Clean up messages
  return messages.map((m) => ({
    ...m,
    text: m.text
      .replace(/\[STATUS:.*?\]/g, "")  // remove status lines
      .replace(/\n{3,}/g, "\n\n")       // collapse multiple blank lines
      .trim(),
  })).filter((m) => m.text.length > 0);
}

export function JacekPanel({ visible, onClose }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollOutput = useCallback(async () => {
    try {
      const data = await fetchSessionOutput(JACEK_SESSION, 200);
      if (data?.output) {
        setMessages(parseOutput(data.output));
        setReady(true);
      }
    } catch {
      // Session doesn't exist yet
    }
  }, []);

  useEffect(() => {
    if (visible) {
      pollOutput();
      pollRef.current = setInterval(pollOutput, 1500);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [visible, pollOutput]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  const ensureSession = useCallback(async () => {
    if (ready) return;
    setCreating(true);
    try {
      await createSession({
        targets: [],
        name: JACEK_NAME,
        prompt: JACEK_PROMPT,
        agentType: "claude",
        dangerouslySkipPermissions: true,
      });
      await new Promise((r) => setTimeout(r, 10000));
      setReady(true);
    } catch (err: any) {
      if (err.message?.includes("already exists")) {
        setReady(true);
      } else {
        console.error("Failed to create Jacek:", err);
      }
    } finally {
      setCreating(false);
    }
  }, [ready]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || sending) return;
    setInput("");
    setSending(true);
    try {
      if (!ready) await ensureSession();
      await sendSessionInput(JACEK_SESSION, text);
    } catch (err: any) {
      console.error("Failed to send to Jacek:", err);
    } finally {
      setSending(false);
    }
  }, [sending, ready, ensureSession]);

  if (!visible) return null;

  return (
    <div className="jacek-panel">
      <div className="jacek-header">
        <span className="jacek-title">Jacek</span>
        <span className="jacek-subtitle">project overseer</span>
        <button className="jacek-close" onClick={onClose}>x</button>
      </div>

      <div className="jacek-quick-actions">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            className="jacek-quick-btn"
            onClick={() => sendMessage(action.message)}
            disabled={sending || creating}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="jacek-messages" ref={messagesRef}>
        {creating && <div className="jacek-system-msg">Starting Jacek session...</div>}
        {!ready && !creating && (
          <div className="jacek-system-msg">Click a button or send a message to start.</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`jacek-bubble jacek-bubble-${msg.role}`}>
            {msg.role === "jacek" ? (
              <div className="jacek-bubble-text jacek-markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
              </div>
            ) : (
              <div className="jacek-bubble-text">{msg.text}</div>
            )}
          </div>
        ))}
        {sending && messages.length > 0 && (
          <div className="jacek-bubble jacek-bubble-jacek">
            <div className="jacek-bubble-text jacek-typing">thinking...</div>
          </div>
        )}
      </div>

      <div className="jacek-input-area">
        <textarea
          ref={inputRef}
          className="jacek-input"
          placeholder="Ask Jacek anything..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage(input);
            }
          }}
          rows={2}
          disabled={sending || creating}
        />
        <button
          className="jacek-send"
          onClick={() => sendMessage(input)}
          disabled={sending || creating || !input.trim()}
        >
          {creating || sending ? "..." : "send"}
        </button>
      </div>
    </div>
  );
}
