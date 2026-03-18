import { useState, useRef, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createSession, sendSessionInput } from "../api";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const JACEK_NAME = "jacek-overseer";
const JACEK_SESSION = `claude-${JACEK_NAME}`;

// Quick actions — each has a label (shown as button) and a message (sent to Jacek).
// To add a new quick action, add an entry here and Jacek will handle it.
// See CLAUDE.md "Adding Jacek Quick Actions" for instructions.
const QUICK_ACTIONS = [
  { label: "Show all PRs", message: "Find all my open PRs across all repos using gh pr list. Group by feature/ticket." },
  { label: "Session status", message: "Show all active sessions, what repo they're in, and their current status." },
  { label: "What's blocked?", message: "Check all sessions for errors or things waiting for my input. Only show sessions that need attention." },
  { label: "Summary", message: "Give me a brief summary of everything happening: active sessions, open PRs, any blockers." },
];

export function JacekPanel({ visible, onClose }: Props) {
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const responseRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResponseRef = useRef<string>("");

  // Poll response file when loading
  const pollResponse = useCallback(async () => {
    try {
      const res = await fetch("/api/jacek/response", { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.content && data.content.trim() && data.content !== lastResponseRef.current) {
        lastResponseRef.current = data.content;
        setResponse(data.content);
        setLoading(false);
        // Stop polling once we get a response
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    } catch {}
  }, []);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Check if session exists on open
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
      const promptRes = await fetch("/api/jacek/prompt", { credentials: "include" });
      const { prompt } = await promptRes.json();
      await createSession({
        targets: [],
        name: JACEK_NAME,
        prompt,
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

  const runAction = useCallback(async (label: string, message: string) => {
    if (loading) return;
    setActiveAction(label);
    setResponse(null);
    setLoading(true);
    lastResponseRef.current = "";

    try {
      if (!ready) await ensureSession();
      // Clear old response before sending new action
      await fetch("/api/jacek/response", { method: "DELETE", credentials: "include" });
      lastResponseRef.current = "";
      await sendSessionInput(JACEK_SESSION, message);
      // Start polling for response
      pollRef.current = setInterval(pollResponse, 1500);
    } catch (err: any) {
      console.error("Failed to send to Jacek:", err);
      setResponse("Failed to reach Jacek. Is the server running?");
      setLoading(false);
    }
  }, [loading, ready, ensureSession, pollResponse]);

  if (!visible) return null;

  return (
    <div className="jacek-panel">
      <div className="jacek-header">
        <span className="jacek-title">Jacek</span>
        <span className="jacek-subtitle">project overseer</span>
        <button className="jacek-close" onClick={onClose}>x</button>
      </div>

      <div className="jacek-actions-grid">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            className={`jacek-action-btn ${activeAction === action.label ? "jacek-action-active" : ""}`}
            onClick={() => runAction(action.label, action.message)}
            disabled={loading || creating}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="jacek-response" ref={responseRef}>
        {creating && (
          <div className="jacek-system-msg">Starting Jacek session...</div>
        )}
        {!creating && !loading && !response && (
          <div className="jacek-system-msg">Click an action above to get started.</div>
        )}
        {loading && (
          <div className="jacek-loading">
            <span className="jacek-loading-dot" />
            Jacek is working on "{activeAction}"...
          </div>
        )}
        {response && (
          <div className="jacek-markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{response}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
