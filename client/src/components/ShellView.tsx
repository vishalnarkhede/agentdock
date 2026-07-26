import { useState, useEffect } from "react";
import { openShellSession } from "../api";
import { TerminalView } from "./TerminalView";

interface Worktree {
  repoPath: string;
  wtDir: string;
}

interface Props {
  sessionName: string;
  worktrees: Worktree[];
  onClose?: () => void;
}

function repoLabel(wt: Worktree): string {
  return wt.repoPath.split("/").filter(Boolean).pop() || wt.repoPath;
}

/**
 * A plain shell in one of the agent's worktrees.
 *
 * Named "Shell" rather than "Terminal" on purpose: the agent's own pane is
 * already a terminal, and the toolbar's "Open in Terminal" launches the OS
 * terminal app. Three things called terminal in one screen is what this avoids.
 *
 * The shell is an ordinary tmux session, so it streams through the same
 * TerminalView and WebSocket as an agent pane.
 */
export function ShellView({ sessionName, worktrees, onClose }: Props) {
  const [selected, setSelected] = useState(0);
  const [shellSession, setShellSession] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const worktree = worktrees[selected];

  // Reset the picker if the agent's worktrees change underneath us (a grouped
  // agent can lose one), rather than indexing past the end.
  useEffect(() => {
    if (selected >= worktrees.length) setSelected(0);
  }, [worktrees.length, selected]);

  useEffect(() => {
    if (!worktree) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    openShellSession(sessionName, worktree.wtDir)
      .then((name) => {
        if (!cancelled) setShellSession(name);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || "Failed to open shell");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionName, worktree?.wtDir]);

  if (worktrees.length === 0) {
    return <div className="plan-empty">This agent has no worktree to open a shell in.</div>;
  }

  return (
    <div className="shell-view">
      {worktrees.length > 1 && (
        <div className="shell-view-switcher">
          {worktrees.map((wt, i) => (
            <button
              key={wt.wtDir}
              className={`changes-switcher-btn${i === selected ? " changes-switcher-active" : ""}`}
              onClick={() => setSelected(i)}
              title={wt.wtDir}
            >
              {repoLabel(wt)}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="plan-loading">opening shell...</div>
      ) : error ? (
        <div className="form-error">{error}</div>
      ) : shellSession ? (
        <TerminalView
          key={shellSession}
          sessionName={shellSession}
          onClosed={onClose}
          isActive
          embedded
        />
      ) : null}
    </div>
  );
}
