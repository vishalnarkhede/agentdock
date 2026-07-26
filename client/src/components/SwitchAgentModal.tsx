import { useEffect } from "react";
import { createPortal } from "react-dom";
import { agentTypeLabel } from "../session-messages";
import type { SettingsHealth } from "../api";
import type { AgentType } from "../types";

type AgentTool = Extract<AgentType, "claude" | "codex" | "cursor">;

const AGENT_OPTIONS: Array<{
  type: AgentTool;
  command: string;
  description: string;
}> = [
  {
    type: "claude",
    command: "claude",
    description: "Strong default for product work, repo edits, and long-running implementation sessions.",
  },
  {
    type: "codex",
    command: "codex",
    description: "OpenAI coding agent for continuing the current chat from the captured session context.",
  },
  {
    type: "cursor",
    command: "agent",
    description: "Cursor Agent CLI for continuing inside the same tmux session and checkout.",
  },
];

export function SwitchAgentModal({
  currentAgent,
  health,
  healthLoading,
  error,
  disabled,
  onClose,
  onSelect,
}: {
  currentAgent: AgentType;
  health: SettingsHealth | null;
  healthLoading: boolean;
  error: string;
  disabled?: boolean;
  onClose: () => void;
  onSelect: (agentType: AgentType) => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disabled) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [disabled, onClose]);

  const close = () => {
    if (!disabled) onClose();
  };

  return createPortal(
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-modal switch-agent-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="switch-agent-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <span className="settings-title" id="switch-agent-title">Switch agent</span>
          <button type="button" className="settings-close-btn" onClick={close} disabled={disabled} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="switch-agent-body">
          <p className="switch-agent-intro">
            Choose which agent CLI should continue this chat. Agentdock will compact the current conversation, exit the current CLI, and start the selected one in the same session.
          </p>
          {healthLoading && <div className="switch-agent-health">Checking installed agents...</div>}
          <div className="switch-agent-list">
            {AGENT_OPTIONS.map((option) => {
              const tool = health?.[option.type];
              const isCurrent = option.type === currentAgent;
              const unavailable = !!health && !tool?.installed;
              const status = isCurrent
                ? "Current"
                : unavailable
                  ? "Not installed"
                  : tool?.version || "Available";

              return (
                <button
                  key={option.type}
                  type="button"
                  className={`switch-agent-option${isCurrent ? " switch-agent-option-current" : ""}${unavailable ? " switch-agent-option-unavailable" : ""}`}
                  onClick={() => onSelect(option.type)}
                  disabled={disabled || isCurrent || unavailable}
                >
                  <span className="switch-agent-mark" aria-hidden="true">
                    {option.type === "claude" ? "C" : option.type === "codex" ? "O" : "A"}
                  </span>
                  <span className="switch-agent-copy">
                    <span className="switch-agent-name">{agentTypeLabel(option.type)}</span>
                    <span className="switch-agent-description">{option.description}</span>
                    <span className="switch-agent-command">{option.command}</span>
                  </span>
                  <span className={`switch-agent-badge${isCurrent ? " switch-agent-badge-current" : ""}${unavailable ? " switch-agent-badge-muted" : ""}`}>
                    {status}
                  </span>
                </button>
              );
            })}
          </div>
          {error && <div className="form-error switch-agent-error">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
