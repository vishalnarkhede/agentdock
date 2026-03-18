import { useState, useRef, useEffect, useCallback } from "react";
import { createSession, sendSessionInput, fetchSessionOutput } from "../api";

interface Props {
  visible: boolean;
  onClose: () => void;
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
- Use markdown tables for lists of PRs or sessions
- Use bullet points, not paragraphs
- Bold the important parts (status, blockers, action items)
- Never apologize or add filler text`;

const QUICK_ACTIONS = [
  { label: "Show all PRs", message: "List all tracked PRs grouped by feature, show their status in a table" },
  { label: "Session status", message: "List all active sessions and what each one is doing right now" },
  { label: "What's blocked?", message: "Check all sessions for any errors or things that need my input" },
];

export function JacekPanel({ visible, onClose }: Props) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check if session exists and poll output
  const pollOutput = useCallback(async () => {
    try {
      const data = await fetchSessionOutput(JACEK_SESSION);
      if (data?.output) {
        setOutput(data.output);
        setReady(true);
      }
    } catch {
      // Session doesn't exist yet
    }
  }, []);

  // Start/stop polling when panel is visible
  useEffect(() => {
    if (visible) {
      pollOutput();
      pollRef.current = setInterval(pollOutput, 1500);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [visible, pollOutput]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

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
      // Wait for boot
      await new Promise((r) => setTimeout(r, 10000));
      setReady(true);
    } catch (err: any) {
      // Session might already exist
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

      <div className="jacek-output" ref={outputRef}>
        {creating && <div className="jacek-creating">Starting Jacek session...</div>}
        {!ready && !creating && <div className="jacek-creating">Click a button or send a message to start Jacek.</div>}
        {output ? (
          <pre className="jacek-terminal">{output}</pre>
        ) : ready ? (
          <div className="jacek-creating">Waiting for output...</div>
        ) : null}
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
          {creating ? "..." : sending ? "..." : "send"}
        </button>
      </div>
    </div>
  );
}
