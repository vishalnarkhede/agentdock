import { useState } from "react";
import { deleteSession } from "../api";
import { queueBucket, type QueueBucket } from "../queue";
import { Icon } from "./Icon";
import type { SessionInfo } from "../types";
import "../styles/subagents.css";

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, "~/");
}

const BUCKET_LABEL: Record<QueueBucket, string> = {
  blocked: "Needs you",
  review: "Ready",
  working: "Working",
  idle: "Idle",
  stale: "Stale",
};

function agentLabel(agentType: SessionInfo["agentType"]): string | null {
  if (agentType === "claude") return "Claude";
  if (agentType === "cursor") return "Cursor";
  return null;
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
    await Promise.all(children.map((c) => deleteSession(c.name).catch(() => {})));
    onRefresh();
  };

  if (children.length === 0) {
    return (
      <div className="sa">
        <div className="sa-empty">
          <div className="sa-empty-tile">
            <Icon name="users" size={20} />
          </div>
          <div className="sa-empty-title">No sub-agents yet</div>
          <p className="sa-empty-hint">
            This session will have them as soon as you ask it to fan the work out — each
            sub-agent runs as its own agent alongside this one.
          </p>
        </div>
      </div>
    );
  }

  const buckets = children.map(queueBucket);
  const workingCount = buckets.filter((b) => b === "working").length;
  const blockedCount = buckets.filter((b) => b === "blocked").length;

  return (
    <div className="sa">
      <div className="sa-stats">
        <Stat value={workingCount} label="working" tone="working" />
        <Stat value={blockedCount} label="waiting on you" tone="blocked" />
        <Stat value={children.length} label={children.length === 1 ? "sub-agent" : "sub-agents"} />
        <button className="sa-killall" onClick={handleKillAll}>
          <Icon name="stop" size={13} />
          Kill all
        </button>
      </div>

      <div className="sa-list">
        {children.map((child, i) => {
          const bucket = buckets[i];
          return (
            <div
              key={child.name}
              className={`sa-card sa-card--${bucket}`}
              onClick={() => onSelectChild(child.name)}
            >
              <div className="sa-card-top">
                <span className={`sa-dot sa-dot--${bucket}`} />
                <span className="sa-name">{child.displayName}</span>
                <span className={`sa-pill sa-pill--${bucket}`}>{BUCKET_LABEL[bucket]}</span>
                <span className="sa-age">{timeAgo(child.created)}</span>
              </div>

              {child.statusLine?.message && (
                <div className="sa-doing">{child.statusLine.message}</div>
              )}

              <div className="sa-card-foot">
                <span className="sa-facts">
                  {agentLabel(child.agentType) && <span>{agentLabel(child.agentType)}</span>}
                  <span className="sa-path">{shortPath(child.path)}</span>
                </span>
                <button
                  className="sa-kill"
                  title="Kill this sub-agent"
                  disabled={killing === child.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleKill(child.name);
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
                <button
                  className={bucket === "blocked" ? "sa-open sa-open--answer" : "sa-open"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectChild(child.name);
                  }}
                >
                  {bucket === "blocked" ? "Answer" : "Open"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="sa-note">
        A sub-agent's work lands in the parent's worktree, so it shows up in the parent's diff.
      </p>
    </div>
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: Extract<QueueBucket, "working" | "blocked">;
}) {
  return (
    <div className="sa-stat">
      <div className={tone ? `sa-stat-value sa-stat-value--${tone}` : "sa-stat-value"}>{value}</div>
      <div className="sa-stat-label">{label}</div>
    </div>
  );
}
