import { useState } from "react";
import { deleteSession } from "../api";
import { agentTypeLabel, worktreeClause } from "../session-messages";
import { ConfirmActionModal, type ConfirmAction } from "./ConfirmActionModal";
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
  if (session.status === "shell") return "inactive";
  if (session.status === "unknown") return "sleeping";
  return session.status;
}

function statusLabel(session: SessionInfo): string {
  const s = getDisplayStatus(session);
  if (s === "working") return "working...";
  if (s === "sleeping") return "idle";
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
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const parent = sessions.find((s) => s.name === parentSession);
  const childNames = parent?.children ?? [];
  const children = childNames
    .map((name) => sessions.find((s) => s.name === name))
    .filter(Boolean) as SessionInfo[];

  const handleKill = (session: SessionInfo) => {
    setConfirmAction({
      title: "Stop sub-agent?",
      message: `Stop "${session.displayName}"?`,
      details: ["The terminal will close immediately.", worktreeClause([session]).trim()].filter(Boolean),
      confirmLabel: "Stop sub-agent",
      busyLabel: "Stopping...",
      tone: "danger",
      onConfirm: async () => {
        setKilling(session.name);
        try {
          await deleteSession(session.name);
          onRefresh();
        } finally {
          setKilling(null);
        }
      },
    });
  };

  const handleKillAll = async () => {
    setConfirmAction({
      title: "Stop all sub-agents?",
      message: `${children.length} sub-agent${children.length === 1 ? "" : "s"} will be stopped.`,
      details: ["Each terminal will close immediately.", worktreeClause(children, true).trim()].filter(Boolean),
      confirmLabel: "Stop all",
      busyLabel: "Stopping...",
      tone: "danger",
      onConfirm: async () => {
        await Promise.all(children.map((c) => deleteSession(c.name).catch(() => {})));
        onRefresh();
      },
    });
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

  const workingCount = children.filter((c) => getDisplayStatus(c) === "working").length;
  const doneCount = children.filter((c) => getDisplayStatus(c) === "done").length;
  const errorCount = children.filter((c) => getDisplayStatus(c) === "error").length;

  return (
    <>
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
          Stop all
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
                    {agentTypeLabel(child.agentType)}
                  </span>
                )}
                <button
                  className="sub-agent-view-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectChild(child.name);
                  }}
                >
                  View &rarr;
                </button>
                <button
                  className="sub-agent-kill"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleKill(child);
                  }}
                  disabled={killing === child.name}
                >
                  {killing === child.name ? "..." : "Stop"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
    {confirmAction && (
      <ConfirmActionModal
        action={confirmAction}
        onClose={() => setConfirmAction(null)}
      />
    )}
    </>
  );
}
