import { useState } from "react";
import { deleteSession } from "../api";
import type { SessionInfo } from "../types";

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getDisplayStatus(session: SessionInfo): string {
  if (session.statusLine?.type) return session.statusLine.type;
  if (session.status === "shell") return "done";
  return session.status;
}

function statusLabel(session: SessionInfo): string {
  const s = getDisplayStatus(session);
  if (s === "working") return "working...";
  if (s === "waiting") return "idle";
  return s;
}

interface Props {
  parentSession: string;
  sessions: SessionInfo[];
  onSelectChild: (childName: string) => void;
  onRefresh: () => void;
}

export function SubAgentsView({ parentSession, sessions, onSelectChild, onRefresh }: Props) {
  const [killing, setKilling] = useState<string | null>(null);

  const parent = sessions.find((s) => s.name === parentSession);
  const childNames = parent?.children ?? [];
  const children = childNames
    .map((name) => sessions.find((s) => s.name === name))
    .filter(Boolean) as SessionInfo[];

  const handleKill = async (name: string) => {
    setKilling(name);
    try {
      await deleteSession(name);
      onRefresh();
    } finally {
      setKilling(null);
    }
  };

  const handleKillAll = async () => {
    if (!confirm(`Kill all ${children.length} sub-agents?`)) return;
    for (const child of children) {
      try {
        await deleteSession(child.name);
      } catch {
        // best effort
      }
    }
    onRefresh();
  };

  if (children.length === 0) {
    return (
      <div className="sub-agents-view">
        <div className="sub-agents-empty">
          <div className="sub-agents-empty-icon">&#x2693;</div>
          <div>no sub-agents running</div>
          <div className="sub-agents-empty-hint">
            the agent can spawn sub-agents using the ad-agent CLI
          </div>
        </div>
      </div>
    );
  }

  const workingCount = children.filter((c) => c.status === "working").length;
  const doneCount = children.filter((c) => getDisplayStatus(c) === "done" || c.status === "waiting").length;
  const errorCount = children.filter((c) => getDisplayStatus(c) === "error").length;

  return (
    <div className="sub-agents-view">
      <div className="sub-agents-header">
        <div className="sub-agents-summary">
          <span className="sub-agents-count">
            {children.length} sub-agent{children.length !== 1 ? "s" : ""}
          </span>
          <div className="sub-agents-progress">
            {children.map((child) => {
              const s = getDisplayStatus(child);
              return (
                <span
                  key={child.name}
                  className={`sub-agents-progress-pip status-${s}`}
                  title={`${child.displayName}: ${s}`}
                />
              );
            })}
          </div>
          <div className="sub-agents-stats">
            {workingCount > 0 && <span className="sub-agents-stat status-working">{workingCount} working</span>}
            {doneCount > 0 && <span className="sub-agents-stat status-done">{doneCount} done</span>}
            {errorCount > 0 && <span className="sub-agents-stat status-error">{errorCount} error</span>}
          </div>
        </div>
        <button className="btn btn-stop btn-sm" onClick={handleKillAll}>
          kill all
        </button>
      </div>

      <div className="sub-agents-grid">
        {children.map((child) => {
          const ds = getDisplayStatus(child);
          return (
            <div
              key={child.name}
              className={`sub-agent-card sub-agent-card--${ds}`}
              onClick={() => onSelectChild(child.name)}
            >
              <div className="sub-agent-card-header">
                <span className={`sub-agent-dot status-${ds}`} />
                <span className="sub-agent-name">{child.displayName}</span>
                <span className={`sub-agent-status-badge status-${ds}`}>
                  {statusLabel(child)}
                </span>
              </div>

              {child.statusLine?.message && (
                <div className={`sub-agent-message status-${child.statusLine.type}`}>
                  {child.statusLine.message}
                </div>
              )}

              <div className="sub-agent-card-footer">
                <span className="sub-agent-path">
                  {child.path.replace(/^\/Users\/[^/]+\//, "~/")}
                </span>
                <span className="sub-agent-age">{timeAgo(child.created)}</span>
                {child.agentType && (
                  <span className="sub-agent-agent">
                    {child.agentType === "claude" ? "Claude" : "Cursor"}
                  </span>
                )}
                <button
                  className="sub-agent-view-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectChild(child.name);
                  }}
                >
                  view &rarr;
                </button>
                <button
                  className="sub-agent-kill"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleKill(child.name);
                  }}
                  disabled={killing === child.name}
                >
                  {killing === child.name ? "..." : "kill"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
