import { useState, useRef, useEffect, useCallback } from "react";
import { createSession, sendSessionInput } from "../api";

interface Props {
  visible: boolean;
  onClose: () => void;
  sessions: { name: string }[];
  onSessionCreated: () => void;
}

const JACEK_SESSION = "jacek-overseer";
const JACEK_PROMPT = `You are Jacek, the project overseer for AgentDock. Your job is to help the user stay organized across all their Claude coding sessions.

You have access to the agentdock MCP server. Use it to:
- Track and summarize PRs across all sessions (register_pr, list_prs)
- Check what each session is working on (list_sessions, get_session_output)
- Read and write shared notes for coordination (add_note, list_notes)

When asked to summarize, group PRs by feature/epic and show their status.
Be concise and use tables when helpful.`;

const QUICK_ACTIONS = [
  { label: "Show all PRs", message: "List all tracked PRs grouped by feature, show their status" },
  { label: "Session status", message: "List all active sessions and what each one is doing right now" },
  { label: "What's blocked?", message: "Check all sessions for any errors or things that need my input" },
];

export function JacekPanel({ visible, onClose, sessions, onSessionCreated }: Props) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const jacekExists = sessions.some((s) => s.name === JACEK_SESSION);

  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [visible]);

  const ensureJacek = useCallback(async () => {
    if (jacekExists) return;
    setCreating(true);
    try {
      await createSession({
        targets: [],
        name: JACEK_SESSION,
        prompt: JACEK_PROMPT,
        agentType: "claude",
        dangerouslySkipPermissions: true,
      });
      onSessionCreated();
    } catch (err: any) {
      console.error("Failed to create Jacek session:", err);
    } finally {
      setCreating(false);
    }
  }, [jacekExists, onSessionCreated]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const needsCreation = !jacekExists;
      if (needsCreation) {
        await ensureJacek();
        // Wait for the Claude session to fully boot (trust prompt + agent ready)
        await new Promise((r) => setTimeout(r, 10000));
      }
      await sendSessionInput(JACEK_SESSION, text);
      setInput("");
    } catch (err: any) {
      console.error("Failed to send to Jacek:", err);
    } finally {
      setSending(false);
    }
  }, [ensureJacek, jacekExists]);

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

      <div className="jacek-status">
        {creating || sending ? (jacekExists ? "Sending to Jacek..." : "Creating Jacek session & sending...") :
         !jacekExists ? "Jacek session will start on first message" :
         "Connected to Jacek — see output in sidebar"}
      </div>

      {jacekExists && (
        <div className="jacek-hint">
          Switch to the "{JACEK_SESSION}" session in the sidebar to see Jacek's full output.
        </div>
      )}

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
          {sending ? "..." : "send"}
        </button>
      </div>
    </div>
  );
}
