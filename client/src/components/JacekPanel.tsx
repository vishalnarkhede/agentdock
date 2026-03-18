import { useState, useRef, useEffect, useCallback } from "react";
// Uses relative URLs — same origin as the app

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

const QUICK_ACTIONS = [
  { label: "Show all PRs", message: "List all tracked PRs grouped by feature, show their status" },
  { label: "Session status", message: "List all active sessions and what each one is doing right now" },
  { label: "What's blocked?", message: "Check all sessions for any errors or things that need my input" },
];

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function JacekPanel({ visible, onClose }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [toolCall, setToolCall] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load history on open
  useEffect(() => {
    if (visible && messages.length === 0) {
      fetch("/api/jacek/history", { credentials: "include" })
        .then((r) => r.json())
        .then((data) => {
          if (data.messages?.length > 0) {
            setMessages(data.messages);
          }
        })
        .catch(() => {});
    }
  }, [visible]);

  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }]);
    setLoading(true);
    setToolCall(null);

    try {
      const res = await fetch("/api/jacek/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }));
        setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${err.error}` }]);
        setLoading(false);
        return;
      }

      // Read SSE stream
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      if (reader) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "text") {
                assistantText += parsed.text;
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === "assistant") {
                    updated[updated.length - 1] = { ...last, text: assistantText };
                  } else {
                    updated.push({ role: "assistant", text: assistantText });
                  }
                  return updated;
                });
              } else if (parsed.type === "tool_call") {
                setToolCall(parsed.name);
              } else if (parsed.type === "done") {
                setToolCall(null);
              }
            } catch {}
          }
        }
      }

      if (!assistantText) {
        setMessages((prev) => [...prev, { role: "assistant", text: "(no response)" }]);
      }
    } catch (err: any) {
      setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${err.message}` }]);
    } finally {
      setLoading(false);
      setToolCall(null);
    }
  }, [loading]);

  const handleReset = async () => {
    await fetch("/api/jacek/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ reset: true }),
    }).catch(() => {});
    setMessages([]);
  };

  if (!visible) return null;

  return (
    <div className="jacek-panel">
      <div className="jacek-header">
        <span className="jacek-title">Jacek</span>
        <span className="jacek-subtitle">project overseer</span>
        <button className="jacek-close" onClick={handleReset} title="Clear conversation">
          clear
        </button>
        <button className="jacek-close" onClick={onClose}>x</button>
      </div>

      <div className="jacek-quick-actions">
        {QUICK_ACTIONS.map((action) => (
          <button
            key={action.label}
            className="jacek-quick-btn"
            onClick={() => sendMessage(action.message)}
            disabled={loading}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="jacek-messages">
        {messages.length === 0 && !loading && (
          <div className="jacek-empty">Ask Jacek anything about your sessions and PRs.</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`jacek-msg jacek-msg-${msg.role}`}>
            <div className="jacek-msg-role">{msg.role === "user" ? "you" : "jacek"}</div>
            <div className="jacek-msg-text">{msg.text}</div>
          </div>
        ))}
        {loading && (
          <div className="jacek-msg jacek-msg-assistant">
            <div className="jacek-msg-role">jacek</div>
            <div className="jacek-msg-text jacek-thinking">
              {toolCall ? `calling ${toolCall}...` : "thinking..."}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
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
          disabled={loading}
        />
        <button
          className="jacek-send"
          onClick={() => sendMessage(input)}
          disabled={loading || !input.trim()}
        >
          {loading ? "..." : "send"}
        </button>
      </div>
    </div>
  );
}
