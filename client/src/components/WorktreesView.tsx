import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWorktrees, type WorktreeInfo } from "../api";
import { Icon } from "./Icon";
import "../styles/worktrees.css";

/**
 * The tail of a path, which is the part that identifies it.
 *
 * Nearly every worktree sits under the same base directory, so the head of the
 * path is the same noise on every row. Truncating from the front with CSS would
 * mean `direction: rtl`, which moves the leading slash to the end and reads
 * wrong; taking the last few segments says the same thing and stays LTR.
 */
function pathTail(path: string, segments = 3): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}

/**
 * Every worktree on disk, and who owns it.
 *
 * AgentDock removes a worktree when its session is killed, but a session killed
 * by hand, a crash, or a worktree made outside AgentDock all leave one behind —
 * and until now nothing showed you that. The ones with a session are a way to
 * jump to it; the ones without are the answer to "what is taking up my disk and
 * my branch list".
 */
export function WorktreesView({
  onOpenSession,
  activeSession,
}: {
  onOpenSession: (sessionName: string) => void;
  activeSession?: string | null;
}) {
  const [all, setAll] = useState<WorktreeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetchWorktrees()
      .then((w) => alive && setAll(w))
      .catch((e) => alive && setError(e.message));
    search.current?.focus();
    return () => {
      alive = false;
    };
  }, []);

  /* Matches anything the eye would search by: the branch, the repo, the session
     it belongs to, or any part of the path. */
  const shown = useMemo(() => {
    const list = (all ?? []).filter((w) => !w.primary);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((w) =>
      [w.branch ?? "", w.repo, w.session ?? "", w.path].some((f) => f.toLowerCase().includes(q)),
    );
  }, [all, query]);

  const orphans = shown.filter((w) => !w.sessionName).length;

  if (error) return <div className="wt-empty">{error}</div>;
  if (!all) return <div className="wt-empty">reading git…</div>;

  return (
    <div className="wt">
      <div className="wt-head">
        <span className="wt-search">
          <Icon name="search" size={13} />
          <input
            ref={search}
            className="wt-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="branch, repo, session or path…"
            spellCheck={false}
          />
          {query && (
            <button className="wt-search-clear" onClick={() => setQuery("")} aria-label="Clear">
              ×
            </button>
          )}
        </span>
        <span className="wt-count">
          {shown.length} worktree{shown.length === 1 ? "" : "s"}
          {orphans > 0 && <span className="wt-count-orphans"> · {orphans} with no session</span>}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="wt-empty">
          {all.length === 0 ? "No worktrees in the configured repos." : "Nothing matches."}
        </div>
      ) : (
        <ul className="wt-list">
          {shown.map((w) => {
            const jumpable = Boolean(w.sessionName);
            return (
              <li
                key={w.path}
                className={`wt-row${w.sessionName === activeSession ? " wt-row-active" : ""}`}
                data-orphan={!jumpable}
              >
                <button
                  className="wt-row-main"
                  disabled={!jumpable}
                  onClick={() => w.sessionName && onOpenSession(w.sessionName)}
                  title={jumpable ? `Open ${w.session}` : "No session owns this worktree"}
                >
                  <span className="wt-branch">{w.branch ?? `detached at ${w.head}`}</span>
                  <span className="wt-repo">{w.repo}</span>
                  <span className="wt-path" title={w.path}>{pathTail(w.path)}</span>
                </button>

                <span className="wt-tags">
                  {w.dirty !== null && w.dirty > 0 && (
                    <span className="wt-tag wt-tag-dirty" title="Tracked files with changes">
                      {w.dirty} uncommitted
                    </span>
                  )}
                  {!w.exists && <span className="wt-tag wt-tag-gone">directory missing</span>}
                  {w.prunable && <span className="wt-tag wt-tag-gone">prunable</span>}
                  {jumpable ? (
                    <button className="wt-jump" onClick={() => onOpenSession(w.sessionName as string)}>
                      {w.session}
                      <Icon name="chev" size={12} />
                    </button>
                  ) : (
                    <span className="wt-tag wt-tag-orphan">no session</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
