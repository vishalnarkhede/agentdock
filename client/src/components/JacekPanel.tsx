import { useState, useRef, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createSession, sendSessionInput } from "../api";

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
const RESPONSES_DIR = "/tmp/jacek-responses";

const JACEK_PROMPT = `You are Jacek, the project overseer for AgentDock. You help the user stay organized across all their Claude coding sessions.

You have access to the agentdock MCP server. Use it to:
- Track and summarize PRs across all sessions (register_pr, list_prs)
- Check what each session is working on (list_sessions, get_session_output)
- Read and write shared notes for coordination (add_note, list_notes)
- Send messages to other sessions (send_message) and check replies (get_replies)

CRITICAL OUTPUT RULE:
Your responses are displayed in a rich markdown panel. After processing each request:
1. Write your FULL response as a markdown file to ${RESPONSES_DIR}/response.md using the Write tool
2. Use rich markdown formatting: headers, tables, bullet points, bold, links, code blocks
3. After writing the file, output only "done" to the terminal
4. NEVER output your actual response to the terminal — ONLY to the file

Formatting tips for the markdown file:
- Use ## headers to organize sections
- Use tables for PRs and session lists
- Use **bold** for status and important info
- Use [links](url) for PR URLs
- Use bullet points for lists
- Use > blockquotes for status messages
- Keep it clean and scannable`;

const QUICK_ACTIONS = [
  { label: "Show all PRs", message: "List all tracked PRs grouped by feature with their status and links" },
  { label: "Session status", message: "Show all active sessions, what repo they're in, and their current status" },
  { label: "What's blocked?", message: "Check all sessions for errors or things waiting for my input" },
];

export function JacekPanel({ visible, onClose }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResponseRef = useRef<string>("");

  // Poll the response file for new content
  const pollResponse = useCallback(async () => {
    try {
      const res = await fetch(`/api/jacek/response`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.content && data.content !== lastResponseRef.current) {
        lastResponseRef.current = data.content;
        setMessages((prev) => {
          // Replace last jacek message or add new one
          const last = prev[prev.length - 1];
          if (last?.role === "jacek") {
            return [...prev.slice(0, -1), { role: "jacek", text: data.content }];
          }
          return [...prev, { role: "jacek", text: data.content }];
        });
        setSending(false);
      }
    } catch {
      // Endpoint not available yet
    }
  }, []);

  useEffect(() => {
    if (visible) {
      pollResponse();
      pollRef.current = setInterval(pollResponse, 1500);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [visible, pollResponse]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  // Check if Jacek session exists on mount
  useEffect(() => {
    if (!visible) return;
    fetch(`/api/sessions/${JACEK_SESSION}/output?lines=1`, { credentials: "include" })
      .then((r) => { if (r.ok) setReady(true); })
      .catch(() => {});
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
    setMessages((prev) => [...prev, { role: "user", text }]);
    setSending(true);
    try {
      if (!ready) await ensureSession();
      await sendSessionInput(JACEK_SESSION, text);
    } catch (err: any) {
      console.error("Failed to send to Jacek:", err);
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
        {!ready && !creating && messages.length === 0 && (
          <div className="jacek-system-msg">Click a button or type a message to start.</div>
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
        {sending && (
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
