import { useEffect, useMemo, useRef, useState } from "react";
import { deleteWorktrees, fetchWorktrees, type WorktreeInfo } from "../api";
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
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ path: string; message: string } | null>(null);
  /* Selected by path, so a selection survives filtering and re-fetching. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
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

  const deletable = useMemo(() => shown.filter((w) => !w.sessionName), [shown]);
  const chosen = useMemo(
    () => (all ?? []).filter((w) => selected.has(w.path) && !w.sessionName),
    [all, selected],
  );
  const allShownChosen = deletable.length > 0 && deletable.every((w) => selected.has(w.path));

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAllShown = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownChosen) for (const w of deletable) next.delete(w.path);
      else for (const w of deletable) next.add(w.path);
      return next;
    });
  };

  /**
   * Deleting, one or many.
   *
   * The prompt says what is actually at stake — the directories go, the
   * branches stay, and uncommitted work is named and counted rather than folded
   * into a generic "are you sure". The server refuses dirty worktrees unless
   * told otherwise, so the confirmation and the force flag are the same
   * decision.
   */
  const remove = async (targets: WorktreeInfo[]) => {
    if (targets.length === 0) return;
    const dirty = targets.filter((w) => (w.dirty ?? 0) > 0);
    const dirtyFiles = dirty.reduce((n, w) => n + (w.dirty ?? 0), 0);

    const lines =
      targets.length === 1
        ? [
            `Delete this worktree?`,
            ``,
            `  ${targets[0].path}`,
            targets[0].branch
              ? `  branch ${targets[0].branch} — kept, not deleted`
              : `  detached at ${targets[0].head}`,
          ]
        : [
            `Delete ${targets.length} worktrees?`,
            ``,
            ...targets.slice(0, 8).map((w) => `  ${w.branch ?? w.head} — ${w.repo}`),
            ...(targets.length > 8 ? [`  …and ${targets.length - 8} more`] : []),
            ``,
            `Their branches are kept, not deleted.`,
          ];
    if (dirtyFiles > 0) {
      lines.push(
        ``,
        targets.length === 1
          ? `${dirtyFiles} uncommitted file${dirtyFiles === 1 ? "" : "s"} will be lost.`
          : `${dirty.length} of them hold ${dirtyFiles} uncommitted file${dirtyFiles === 1 ? "" : "s"}, which will be lost.`,
      );
    }
    if (!confirm(lines.join("\n"))) return;

    setBusy(targets.length === 1 ? targets[0].path : "batch");
    setFailed(null);
    const res = await deleteWorktrees(
      targets.map((w) => w.path),
      dirtyFiles > 0,
    );
    setBusy(null);

    if (res.worktrees) {
      setAll(res.worktrees);
      const gone = new Set(res.worktrees.map((w) => w.path));
      setSelected((prev) => new Set([...prev].filter((p) => gone.has(p))));
    }
    const failures = (res.results ?? []).filter((r) => !r.ok);
    if (failures.length === 1) {
      setFailed({ path: failures[0].path, message: failures[0].error || "could not remove it" });
    } else if (failures.length > 1) {
      setFailed({ path: "batch", message: `${failures.length} could not be removed` });
    } else if (!res.worktrees) {
      setFailed({ path: "batch", message: res.error || "could not remove them" });
    }
  };

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
        {deletable.length > 0 && (
          <label className="wt-check wt-check-all" title="Select every one shown that has no session">
            <input type="checkbox" checked={allShownChosen} onChange={toggleAllShown} />
            <span>all</span>
          </label>
        )}

        <span className="wt-count">
          {shown.length} worktree{shown.length === 1 ? "" : "s"}
          {orphans > 0 && <span className="wt-count-orphans"> · {orphans} with no session</span>}
        </span>

        {chosen.length > 0 && (
          <span className="wt-batch">
            <span className="wt-batch-count">{chosen.length} selected</span>
            <button className="wt-batch-clear" onClick={() => setSelected(new Set())}>
              clear
            </button>
            <button
              className="wt-delete wt-batch-delete"
              onClick={() => remove(chosen)}
              disabled={busy !== null}
            >
              {busy === "batch" ? "deleting…" : `delete ${chosen.length}`}
            </button>
          </span>
        )}
      </div>

      {failed?.path === "batch" && <div className="wt-failed wt-failed-batch">{failed.message}</div>}

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
                /* Composite, not the path alone: the same worktree reachable
                   through two repos would otherwise collide, and React keeps
                   stale rows when keys repeat. */
                key={`${w.repoPath}:${w.path}`}
                className={`wt-row${w.sessionName === activeSession ? " wt-row-active" : ""}`}
                data-orphan={!jumpable}
              >
                {jumpable ? (
                  <span className="wt-check-gap" aria-hidden="true" />
                ) : (
                  <label className="wt-check" title="Select for batch delete">
                    <input
                      type="checkbox"
                      checked={selected.has(w.path)}
                      onChange={() => toggle(w.path)}
                    />
                  </label>
                )}
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
                    <>
                      <span className="wt-tag wt-tag-orphan">no session</span>
                      <button
                        className="wt-delete"
                        onClick={() => remove([w])}
                        disabled={busy === w.path}
                        title="Delete this worktree directory — the branch is kept"
                      >
                        {busy === w.path ? "deleting…" : "delete"}
                      </button>
                    </>
                  )}
                </span>
                {failed?.path === w.path && <span className="wt-failed">{failed.message}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
