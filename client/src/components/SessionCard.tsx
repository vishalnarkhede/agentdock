import { useNavigate } from "react-router-dom";
import { deleteSession } from "../api";
import type { SessionInfo } from "../types";

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

interface Props {
  session: SessionInfo;
  onStopped: () => void;
}

export function SessionCard({ session, onStopped }: Props) {
  const navigate = useNavigate();

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSession(session.name);
    onStopped();
  };

  return (
    <div className="session-card" onClick={() => navigate(`/sessions/${session.name}`)}>
      <div className="session-card-titlebar">
        <span className="dots">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </span>
        <span>{session.name}</span>
      </div>
      <div className="session-card-body">
        <div className="session-card-header">
          <span className="session-name">{session.displayName}</span>
          <span className={`session-status ${session.attached ? "attached" : "running"}`}>
            {session.attached ? "attached" : "running"}
          </span>
        </div>
        <div className="session-card-meta">
          <span className="session-age">{timeAgo(session.created)}</span>
          <span className="session-path" title={session.path}>
            {session.path.replace(/^\/Users\/[^/]+\//, "~/")}
          </span>
        </div>
        {session.worktrees.length > 0 && (
          <div className="session-worktrees">
            {session.worktrees.map((wt, i) => (
              <span key={i} className="worktree-badge">
                {wt.wtDir.replace(/^\/Users\/[^/]+\/projects\//, "")}
              </span>
            ))}
          </div>
        )}
        <div className="session-card-actions">
          <button
            className="btn btn-view"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/sessions/${session.name}`);
            }}
          >
            ./view
          </button>
          <button className="btn btn-stop" onClick={handleStop}>
            kill
          </button>
        </div>
      </div>
    </div>
  );
}
