import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addSettingsRepo,
  BranchUnmergedError,
  createRepoWorktree,
  createSession,
  deleteRepoWorktree,
  deleteSettingsRepo,
  WorktreeDirtyError,
  fetchGitSummary,
  fetchRepoBranches,
  fetchRepoWorktrees,
  fetchSettingsRepos,
  type GitBranchComparison,
  type GitDiffStats,
  type GitSummaryResponse,
} from "../api";
import type { AgentType, RepoBranchInfo, RepoConfig, RepoWorktreeInfo } from "../types";

const WORKTREE_SECTION_PREVIEW_LIMIT = 20;
const AGENT_TYPES: Array<{ value: AgentType; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
];

function shortPath(path: string): string {
  return path.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/Users\/[^/]+\//, "~/");
}

function branchLabel(worktree: RepoWorktreeInfo): string {
  return worktree.branch || "detached";
}

function isDetached(worktree: RepoWorktreeInfo): boolean {
  return !worktree.branch || worktree.branch === "detached";
}

/**
 * Branch name, styled to match the one in the agents sidebar — the same fact should
 * not read as the accent in one list and as muted grey in the other.
 *
 * A detached checkout keeps the muted treatment on purpose: "detached" is a state,
 * not a branch, and dressing it as one invites reading it as a ref that exists.
 */
function BranchLabel({ worktree }: { worktree: RepoWorktreeInfo }) {
  const detached = isDetached(worktree);
  return (
    <span
      className={`branch-label worktrees-target-branch${detached ? " branch-label-muted worktrees-target-branch-detached" : ""}`}
      title={detached ? "Detached HEAD — no branch checked out" : branchLabel(worktree)}
    >
      {branchLabel(worktree)}
    </span>
  );
}

function WorktreeAgentLaunchDialog({
  repo,
  worktree,
  onClose,
  onCreated,
}: {
  repo: RepoConfig;
  worktree: RepoWorktreeInfo;
  onClose: () => void;
  onCreated: (sessionName: string) => void;
}) {
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !launching) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [launching, onClose]);

  const run = async () => {
    setLaunching(true);
    setError("");
    try {
      const result = await createSession({
        targets: [repo.alias],
        grouped: true,
        worktreeMode: "direct",
        agentType,
      });
      const firstSession = result.sessions[0];
      if (!firstSession) throw new Error("Agent was not created");
      onCreated(firstSession);
    } catch (err: any) {
      setError(err?.message || "Failed to start agent");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={() => { if (!launching) onClose(); }}>
      <div className="settings-modal worktrees-agent-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">New agent</span>
          <button type="button" className="settings-close-btn" onClick={onClose} disabled={launching} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="worktrees-agent-body">
          <div className="worktrees-agent-target">
            <span className="worktrees-agent-target-label">Worktree</span>
            <span className="worktrees-agent-target-main">
              <span className="worktrees-target-alias">{repo.alias}</span>
              <BranchLabel worktree={worktree} />
            </span>
            <span className="worktrees-target-path" title={repo.path}>{shortPath(repo.path)}</span>
          </div>

          <div className="form-row">
            <label className="form-label">Agent</label>
            <div className="agent-type-selector">
              {AGENT_TYPES.map((agent) => (
                <label key={agent.value} className="radio-label">
                  <input
                    type="radio"
                    name="worktreeAgentType"
                    value={agent.value}
                    checked={agentType === agent.value}
                    onChange={() => setAgentType(agent.value)}
                  />
                  <span>{agent.label}</span>
                </label>
              ))}
            </div>
          </div>

          {error && <div className="form-error worktrees-error">{error}</div>}
        </div>
        <div className="worktrees-new-actions">
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={launching}>Cancel</button>
          <button type="button" className="btn btn-primary btn-large" onClick={run} disabled={launching}>
            {launching ? "Starting..." : "Start agent"}
          </button>
        </div>
      </div>
    </div>
  );
}

function matchesQuery(query: string, values: Array<string | undefined>): boolean {
  if (!query) return true;
  return values.some((value) => value?.toLowerCase().includes(query));
}

function hasStats(stats: GitDiffStats | null | undefined): boolean {
  return Boolean(stats && (stats.files > 0 || stats.additions > 0 || stats.deletions > 0));
}

function DiffStats({ stats, emptyLabel }: { stats: GitDiffStats; emptyLabel: string }) {
  if (!hasStats(stats)) return <span className="worktrees-git-muted">{emptyLabel}</span>;
  return (
    <>
      {stats.files > 0 && <span className="worktrees-git-files">{stats.files} file{stats.files !== 1 ? "s" : ""}</span>}
      {stats.additions > 0 && <span className="diff-stat-add">+{stats.additions}</span>}
      {stats.deletions > 0 && <span className="diff-stat-del">-{stats.deletions}</span>}
    </>
  );
}

function AheadBehind({ comparison }: { comparison: GitBranchComparison }) {
  const hasAheadBehind = comparison.ahead > 0 || comparison.behind > 0;
  return (
    <span className={`worktrees-git-chip ${hasAheadBehind ? "worktrees-git-chip-active" : ""}`} title={`Compared with ${comparison.ref}`}>
      {hasAheadBehind ? (
        <>
          {comparison.ahead > 0 && <span className="diff-stat-add">↑{comparison.ahead}</span>}
          {comparison.behind > 0 && <span className="diff-stat-del">↓{comparison.behind}</span>}
        </>
      ) : (
        <span className="worktrees-git-muted">in sync</span>
      )}
    </span>
  );
}

function WorktreeGitSummary({ repoPath, refreshKey }: { repoPath: string; refreshKey: number }) {
  const [summary, setSummary] = useState<GitSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchGitSummary(repoPath)
      .then((result) => {
        if (!cancelled) setSummary(result);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || "Failed to read git summary");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, refreshKey]);

  if (loading) {
    return <div className="worktrees-git-summary worktrees-git-summary-muted">checking git...</div>;
  }
  if (error) {
    return <div className="worktrees-git-summary worktrees-git-summary-error" title={error}>git unavailable</div>;
  }
  if (!summary) return null;

  const localChanged = hasStats(summary.workingTree);
  const comparison = summary.comparison;
  const committedChanged = hasStats(comparison) || Boolean(comparison && (comparison.ahead > 0 || comparison.behind > 0));

  return (
    <div className="worktrees-git-summary">
      <span className={`worktrees-git-chip ${localChanged ? "worktrees-git-chip-active" : ""}`} title="Uncommitted working tree diff">
        <span className="worktrees-git-chip-label">local</span>
        <DiffStats stats={summary.workingTree} emptyLabel="clean" />
      </span>
      {comparison ? (
        <>
          <span className={`worktrees-git-chip ${committedChanged ? "worktrees-git-chip-active" : ""}`} title={`Committed diff against ${comparison.ref}`}>
            <span className="worktrees-git-chip-label">committed</span>
            <DiffStats stats={comparison} emptyLabel="no diff" />
          </span>
          <AheadBehind comparison={comparison} />
        </>
      ) : (
        <span className="worktrees-git-chip" title="No upstream, main, or master ref found">
          <span className="worktrees-git-muted">no base</span>
        </span>
      )}
    </div>
  );
}

/**
 * Deleting a worktree only removes a checkout — the branch and its commits live in
 * the parent repo and survive. Deleting the branch as well is the destructive part,
 * so it is opt-in and separately confirmed when commits would actually be lost.
 */
function DeleteWorktreeDialog({
  repo,
  branch,
  onDeleted,
  onClose,
}: {
  repo: RepoConfig;
  branch: string;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [actionMode, setActionMode] = useState<"delete" | "unlink">("delete");
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [dirtyChanges, setDirtyChanges] = useState(0);
  const [unmerged, setUnmerged] = useState(false);

  const hasBranch = Boolean(branch) && branch !== "detached";
  const unlinkOnly = actionMode === "unlink";
  // Acknowledged warnings become the force flags on the next attempt.
  const acknowledged = !unlinkOnly && (dirtyChanges > 0 || unmerged);

  const selectActionMode = (mode: "delete" | "unlink") => {
    setActionMode(mode);
    setError("");
    setDirtyChanges(0);
    setUnmerged(false);
  };

  const run = async () => {
    setDeleting(true);
    setError("");
    try {
      if (unlinkOnly) {
        await deleteSettingsRepo(repo.alias);
        onDeleted();
        return;
      }
      await deleteRepoWorktree({
        path: repo.path,
        force: dirtyChanges > 0,
        deleteBranch: hasBranch && deleteBranch,
        forceBranch: unmerged,
      });
      onDeleted();
    } catch (err: any) {
      if (!unlinkOnly && err instanceof WorktreeDirtyError) setDirtyChanges(err.changes || 1);
      else if (!unlinkOnly && err instanceof BranchUnmergedError) setUnmerged(true);
      else setError(err?.message || (unlinkOnly ? "Failed to unlink worktree" : "Failed to delete worktree"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal worktrees-delete-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="worktrees-delete-title">
          {deleteBranch && hasBranch ? "Delete worktree and branch" : "Delete worktree"}
        </h3>
        <p className="worktrees-delete-path" title={repo.path}>{shortPath(repo.path)}</p>

        <div className="worktrees-delete-mode" role="radiogroup" aria-label="Worktree delete mode">
          <label className={`worktrees-delete-mode-option ${!unlinkOnly ? "worktrees-delete-mode-option-active" : ""}`}>
            <input
              type="radio"
              name={`worktree-delete-mode-${repo.alias}`}
              checked={!unlinkOnly}
              onChange={() => selectActionMode("delete")}
            />
            <span className="worktrees-delete-mode-copy">
              <strong>Delete checkout</strong>
              <span>Remove the worktree directory from disk. The branch is kept unless you opt in below.</span>
            </span>
          </label>
          <label className={`worktrees-delete-mode-option ${unlinkOnly ? "worktrees-delete-mode-option-active" : ""}`}>
            <input
              type="radio"
              name={`worktree-delete-mode-${repo.alias}`}
              checked={unlinkOnly}
              onChange={() => selectActionMode("unlink")}
            />
            <span className="worktrees-delete-mode-copy">
              <strong>Unlink only</strong>
              <span>Remove this alias from AgentDock. Keep the checkout, files, and branch.</span>
            </span>
          </label>
        </div>

        {!unlinkOnly && (hasBranch ? (
          <label className="worktrees-delete-option">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => {
                setDeleteBranch(e.target.checked);
                setUnmerged(false); // a fresh choice needs a fresh safety check
              }}
            />
            <span>
              Also delete branch <strong>{branch}</strong>
            </span>
          </label>
        ) : (
          <p className="worktrees-delete-note">Detached checkout — no branch to delete.</p>
        ))}

        <p className="worktrees-delete-note">
          {unlinkOnly
            ? "No files are removed. The worktree can be imported again later."
            : deleteBranch && hasBranch
              ? "The checkout and the branch are both removed. Commits that exist only on this branch are lost."
              : "Only the checkout directory is removed. The branch and its commits are kept."}
        </p>

        {!unlinkOnly && dirtyChanges > 0 && (
          <div className="form-error worktrees-delete-warning">
            {dirtyChanges} uncommitted change{dirtyChanges !== 1 ? "s" : ""} will be lost.
            Confirm to delete anyway.
          </div>
        )}
        {!unlinkOnly && unmerged && (
          <div className="form-error worktrees-delete-warning">
            Branch <strong>{branch}</strong> isn't merged or pushed anywhere — its commits
            will be lost. Confirm to delete anyway.
          </div>
        )}
        {error && <div className="form-error worktrees-delete-warning">{error}</div>}

        <div className="worktrees-delete-actions">
          <button type="button" className="btn" onClick={onClose} disabled={deleting}>Cancel</button>
          <button type="button" className={`btn ${unlinkOnly ? "btn-primary" : "btn-danger"}`} onClick={run} disabled={deleting}>
            {deleting
              ? unlinkOnly ? "Unlinking..." : "Deleting..."
              : unlinkOnly
                ? "Unlink only"
                : acknowledged
                  ? "Delete anyway"
                  : deleteBranch && hasBranch
                    ? "Delete both"
                    : "Delete checkout"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewWorktreeForm({
  repos,
  onCreated,
  onClose,
}: {
  repos: RepoConfig[];
  onCreated: (alias: string) => void;
  onClose: () => void;
}) {
  const [repoAlias, setRepoAlias] = useState(repos[0]?.alias || "");
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [branches, setBranches] = useState<RepoBranchInfo[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [branchPickerOpen, setBranchPickerOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const [newBranch, setNewBranch] = useState("");
  const [base, setBase] = useState("");
  const [alias, setAlias] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !creating) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [creating, onClose]);

  useEffect(() => {
    if (!repoAlias) return;
    let cancelled = false;
    setLoadingBranches(true);
    setError("");
    setBranches([]);
    setSelectedBranch("");
    setBranchQuery("");
    setBranchPickerOpen(true);
    fetchRepoBranches(repoAlias)
      .then((result) => {
        if (cancelled) return;
        setBranches(result.branches);
        setBase(result.defaultBase);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || "Failed to list branches");
      })
      .finally(() => {
        if (!cancelled) setLoadingBranches(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoAlias]);

  const normalizedQuery = branchQuery.trim().toLowerCase();
  const visibleBranches = useMemo(
    () => branches.filter((branch) => matchesQuery(normalizedQuery, [branch.name])),
    [branches, normalizedQuery],
  );

  // Branches already checked out elsewhere can't be picked, so arrow keys skip them.
  const selectableIndexes = useMemo(
    () =>
      visibleBranches.reduce<number[]>((acc, branch, index) => {
        if (!branch.worktreePath) acc.push(index);
        return acc;
      }, []),
    [visibleBranches],
  );

  // Keep the highlight on a row that still exists as the filter narrows the list.
  useEffect(() => {
    setActiveIndex((current) =>
      selectableIndexes.includes(current) ? current : selectableIndexes[0] ?? -1,
    );
  }, [selectableIndexes]);

  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const moveActive = (delta: number) => {
    if (selectableIndexes.length === 0) return;
    const position = selectableIndexes.indexOf(activeIndex);
    const next =
      position === -1
        ? delta > 0
          ? 0
          : selectableIndexes.length - 1
        : (position + delta + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[next]);
  };

  const selectExistingBranch = (branch: RepoBranchInfo, index: number) => {
    if (branch.worktreePath) return;
    setSelectedBranch(branch.name);
    setBranchQuery(branch.name);
    setActiveIndex(index);
    setBranchPickerOpen(false);
  };

  const onBranchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!branchPickerOpen) {
        setBranchPickerOpen(true);
        return;
      }
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!branchPickerOpen) {
        setBranchPickerOpen(true);
        return;
      }
      moveActive(-1);
    } else if (e.key === "Enter" && branchPickerOpen) {
      const branch = visibleBranches[activeIndex];
      if (!branch || branch.worktreePath) return;
      e.preventDefault();
      selectExistingBranch(branch, activeIndex);
    }
  };

  const branchName = mode === "new" ? newBranch.trim() : selectedBranch;
  const canSubmit = Boolean(repoAlias && branchName) && !creating;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setCreating(true);
    setError("");
    try {
      const created = await createRepoWorktree({
        repoAlias,
        branch: branchName,
        createBranch: mode === "new",
        base: mode === "new" ? base : undefined,
        alias: alias.trim() || undefined,
      });
      onCreated(created.alias);
    } catch (err: any) {
      setError(err?.message || "Failed to create worktree");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={() => !creating && onClose()}>
      <form className="settings-modal worktrees-create-modal" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Create worktree</span>
          <button type="button" className="settings-close-btn" onClick={onClose} disabled={creating} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="worktrees-new-body">
          <label className="worktrees-new-field">
            <span className="form-label">Repo</span>
            <select
              className="form-input"
              value={repoAlias}
              onChange={(e) => setRepoAlias(e.target.value)}
            >
              {repos.map((repo) => (
                <option key={repo.alias} value={repo.alias}>{repo.alias}</option>
              ))}
            </select>
          </label>

          <label className="worktrees-new-field">
            <span className="form-label">Type</span>
            <select
              className="form-input"
              value={mode}
              onChange={(e) => {
                const nextMode = e.target.value as "existing" | "new";
                setMode(nextMode);
                if (nextMode === "existing" && !selectedBranch) setBranchPickerOpen(true);
              }}
            >
              <option value="new">New branch</option>
              <option value="existing">Existing branch</option>
            </select>
          </label>

          {mode === "existing" ? (
            <div className="worktrees-new-field worktrees-branch-field">
              <span className="form-label">Branch</span>
              <input
                className="form-input"
                value={branchQuery}
                onChange={(e) => {
                  const nextQuery = e.target.value;
                  setBranchQuery(nextQuery);
                  if (nextQuery !== selectedBranch) setSelectedBranch("");
                  setBranchPickerOpen(true);
                }}
                onKeyDown={onBranchKeyDown}
                role="combobox"
                aria-expanded={branchPickerOpen}
                aria-controls="worktree-branch-list"
                aria-activedescendant={branchPickerOpen && activeIndex >= 0 ? `worktree-branch-${activeIndex}` : undefined}
                placeholder={loadingBranches ? "loading branches..." : "Filter branches..."}
              />
              {branchPickerOpen && (
                <div className="worktrees-branch-list" id="worktree-branch-list" role="listbox" ref={listRef}>
                  {loadingBranches ? (
                    <div className="worktrees-branch-empty">loading...</div>
                  ) : visibleBranches.length === 0 ? (
                    <div className="worktrees-branch-empty">no matching branches</div>
                  ) : (
                    visibleBranches.map((branch, index) => {
                      const inUse = Boolean(branch.worktreePath);
                      const selected = selectedBranch === branch.name;
                      return (
                        <button
                          key={`${branch.remote ? "r" : "l"}:${branch.name}`}
                          id={`worktree-branch-${index}`}
                          data-index={index}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={[
                            "worktrees-branch-row",
                            selected ? "worktrees-branch-row-selected" : "",
                            index === activeIndex ? "worktrees-branch-row-active" : "",
                          ].filter(Boolean).join(" ")}
                          disabled={inUse}
                          title={inUse ? `Already checked out at ${branch.worktreePath}` : branch.ref || branch.name}
                          onMouseEnter={() => !inUse && setActiveIndex(index)}
                          onClick={() => selectExistingBranch(branch, index)}
                        >
                          <span className="worktrees-branch-name">{branch.name}</span>
                          {branch.remote && <span className="worktrees-branch-tag">remote</span>}
                          {inUse && <span className="worktrees-branch-tag">in use</span>}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          ) : (
            <>
              <label className="worktrees-new-field">
                <span className="form-label">Branch name</span>
                <input
                  className="form-input"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="feature/my-change"
                />
              </label>
              <label className="worktrees-new-field">
                <span className="form-label">Based on</span>
                <select className="form-input" value={base} onChange={(e) => setBase(e.target.value)}>
                  {branches.map((branch) => (
                    <option key={`${branch.remote ? "r" : "l"}:${branch.name}`} value={branch.ref || branch.name}>
                      {branch.ref || branch.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          <label className="worktrees-new-field">
            <span className="form-label">Alias</span>
            <input
              className="form-input"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="auto-generated"
            />
          </label>
        </div>

        {error && <div className="form-error worktrees-error worktrees-new-error">{error}</div>}

        <div className="worktrees-new-actions">
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={creating}>Cancel</button>
          <button className="btn btn-primary btn-sm" type="submit" disabled={!canSubmit}>
            {creating ? "Creating..." : "Create worktree"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function WorktreesView({ onAgentCreated }: { onAgentCreated?: (sessionName: string) => void } = {}) {
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [worktrees, setWorktrees] = useState<RepoWorktreeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [summaryVersion, setSummaryVersion] = useState(0);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [discoveredOpen, setDiscoveredOpen] = useState(false);
  const [showAllLinked, setShowAllLinked] = useState(false);
  const [showAllDiscovered, setShowAllDiscovered] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ repo: RepoConfig; branch: string } | null>(null);
  const [launchTarget, setLaunchTarget] = useState<{ repo: RepoConfig; worktree: RepoWorktreeInfo } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("agentdock-focus-worktree-search", handler);
    return () => window.removeEventListener("agentdock-focus-worktree-search", handler);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    const [configured, discovered] = await Promise.all([
      fetchSettingsRepos(),
      fetchRepoWorktrees().catch((err) => {
        setError(err?.message || "Failed to scan worktrees");
        return [] as RepoWorktreeInfo[];
      }),
    ]);
    setRepos(configured);
    setWorktrees(discovered);
    setSummaryVersion((version) => version + 1);
    setAliases((prev) => {
      const next = { ...prev };
      for (const wt of discovered) {
        if (!next[wt.path]) next[wt.path] = wt.suggestedAlias;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Failed to load worktrees");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const worktreeByPath = useMemo(
    () => new Map(worktrees.map((wt) => [wt.path, wt])),
    [worktrees],
  );

  const configuredWorktrees = useMemo(
    () => repos.filter((repo) => {
      const info = worktreeByPath.get(repo.path);
      return info && !info.bare && !info.isMain;
    }),
    [repos, worktreeByPath],
  );

  // A new worktree is cut from a repo's main checkout. Repos that are themselves
  // worktrees are left out — git would resolve them back to the same main repo, so
  // listing them would just be the same choice under a different name.
  const sourceRepos = useMemo(() => {
    const mains = repos.filter((repo) => {
      const info = worktreeByPath.get(repo.path);
      return !info || info.isMain;
    });
    return mains.length > 0 ? mains : repos;
  }, [repos, worktreeByPath]);

  // Agent-owned worktrees are excluded: Agentdock created them and will delete them
  // when the agent stops, so importing one registers an alias to a doomed path.
  const importableWorktrees = useMemo(
    () => worktrees.filter((wt) => !wt.configured && !wt.bare && !wt.isMain && !wt.agentSession),
    [worktrees],
  );

  const agentWorktrees = useMemo(
    () => worktrees.filter((wt) => wt.agentSession && !wt.configured),
    [worktrees],
  );

  const normalizedSearch = search.trim().toLowerCase();

  const visibleConfiguredWorktrees = useMemo(
    () => configuredWorktrees.filter((repo) => {
      const info = worktreeByPath.get(repo.path);
      if (!info) return false;
      return matchesQuery(normalizedSearch, [repo.alias, repo.path, repo.remote, info.branch, info.path, info.remote]);
    }),
    [configuredWorktrees, normalizedSearch, worktreeByPath],
  );

  const visibleImportableWorktrees = useMemo(
    () => importableWorktrees.filter((wt) => matchesQuery(normalizedSearch, [
      wt.repoAlias,
      wt.suggestedAlias,
      wt.branch,
      wt.path,
      wt.remote,
    ])),
    [importableWorktrees, normalizedSearch],
  );

  const visibleAgentWorktrees = useMemo(
    () => agentWorktrees.filter((wt) => matchesQuery(normalizedSearch, [
      wt.repoAlias,
      wt.agentSession,
      wt.branch,
      wt.path,
    ])),
    [agentWorktrees, normalizedSearch],
  );

  const limitWorktreeLists = !normalizedSearch;
  const linkedLimited = limitWorktreeLists && visibleConfiguredWorktrees.length > WORKTREE_SECTION_PREVIEW_LIMIT;
  const discoveredLimited = limitWorktreeLists && visibleImportableWorktrees.length > WORKTREE_SECTION_PREVIEW_LIMIT;

  const displayedConfiguredWorktrees = useMemo(
    () => linkedLimited && !showAllLinked
      ? visibleConfiguredWorktrees.slice(0, WORKTREE_SECTION_PREVIEW_LIMIT)
      : visibleConfiguredWorktrees,
    [linkedLimited, showAllLinked, visibleConfiguredWorktrees],
  );

  const displayedImportableWorktrees = useMemo(
    () => discoveredLimited && !showAllDiscovered
      ? visibleImportableWorktrees.slice(0, WORKTREE_SECTION_PREVIEW_LIMIT)
      : visibleImportableWorktrees,
    [discoveredLimited, showAllDiscovered, visibleImportableWorktrees],
  );

  const selectedImportable = useMemo(
    () => importableWorktrees.filter((wt) => selected.has(wt.path)),
    [importableWorktrees, selected],
  );

  useEffect(() => {
    if (importableWorktrees.length > 0) setDiscoveredOpen(true);
    else if (!search.trim()) setDiscoveredOpen(false);
  }, [importableWorktrees.length, search]);

  const configuredAliases = useMemo(() => new Set(repos.map((repo) => repo.alias)), [repos]);
  const selectedAliases = selectedImportable.map((wt) => (aliases[wt.path] || wt.suggestedAlias).trim());
  const aliasCounts = selectedAliases.reduce<Record<string, number>>((acc, alias) => {
    if (!alias) return acc;
    acc[alias] = (acc[alias] || 0) + 1;
    return acc;
  }, {});
  const hasAliasConflict = selectedAliases.some(
    (alias) => !alias || configuredAliases.has(alias) || aliasCounts[alias] > 1,
  );

  const toggleWorktree = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const importSelected = async () => {
    if (selectedImportable.length === 0 || hasAliasConflict) return;
    setImporting(true);
    setError(null);
    try {
      await Promise.all(selectedImportable.map((wt) => addSettingsRepo({
        alias: (aliases[wt.path] || wt.suggestedAlias).trim(),
        path: wt.path,
        remote: wt.remote,
      })));
      setSelected(new Set());
      await load();
    } catch (err: any) {
      setError(err?.message || "Failed to import worktrees");
    } finally {
      setImporting(false);
    }
  };

  const renderWorktreeRow = (repo: RepoConfig, index: number) => {
    const info = worktreeByPath.get(repo.path);
    if (!info || info.bare || info.isMain) return null;
    return (
      <div key={repo.alias} className="worktrees-target-row">
        <div className="worktrees-target-main">
          <span className="worktrees-row-number" aria-label={`Workspace ${index + 1}`}>{index + 1}</span>
          <span className="worktrees-target-alias">{repo.alias}</span>
          <BranchLabel worktree={info} />
        </div>
        <div className="worktrees-target-path" title={repo.path}>{shortPath(repo.path)}</div>
        <WorktreeGitSummary repoPath={repo.path} refreshKey={summaryVersion} />
        <div className="worktrees-row-actions">
          <button
            className="worktrees-row-action worktrees-row-action-primary"
            title="Start an agent in this worktree"
            onClick={() => setLaunchTarget({ repo, worktree: info })}
          >
            New agent
          </button>
          <button
            className="worktrees-row-action worktrees-row-action-danger"
            title="Delete checkout or unlink it from AgentDock"
            onClick={() => setDeleteTarget({ repo, branch: branchLabel(info) })}
          >
            Delete
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="worktrees-view">
      <div className="worktrees-view-header">
        <input
          ref={searchRef}
          className="worktrees-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearch("");
              searchRef.current?.blur();
            }
          }}
          placeholder="Search worktrees... (⌘K)"
        />
        <div className="worktrees-view-actions">
          <button
            className="btn"
            onClick={refresh}
            disabled={refreshing || loading}
            title="Refresh linked and importable worktrees"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setCreatingWorktree((open) => !open)}
            disabled={loading || sourceRepos.length === 0}
            title={sourceRepos.length === 0 ? "Add a repo first" : "Create a worktree"}
          >
            {creatingWorktree ? "Close" : "New worktree"}
          </button>
        </div>
      </div>

      {error && <div className="form-error worktrees-error">{error}</div>}

      {launchTarget && (
        <WorktreeAgentLaunchDialog
          repo={launchTarget.repo}
          worktree={launchTarget.worktree}
          onClose={() => setLaunchTarget(null)}
          onCreated={(sessionName) => {
            setLaunchTarget(null);
            onAgentCreated?.(sessionName);
          }}
        />
      )}

      {deleteTarget && (
        <DeleteWorktreeDialog
          repo={deleteTarget.repo}
          branch={deleteTarget.branch}
          onClose={() => setDeleteTarget(null)}
          onDeleted={async () => {
            setDeleteTarget(null);
            await refresh();
          }}
        />
      )}

      {creatingWorktree && sourceRepos.length > 0 && (
        <NewWorktreeForm
          repos={sourceRepos}
          onClose={() => setCreatingWorktree(false)}
          onCreated={async () => {
            setCreatingWorktree(false);
            await refresh();
          }}
        />
      )}

      <div className="worktrees-list-shell">
        <div className="worktrees-section-header">
          <div>
            <span>Linked worktrees</span>
            <strong>{visibleConfiguredWorktrees.length}</strong>
          </div>
        </div>
        {loading ? (
          <div className="worktrees-empty">loading...</div>
        ) : configuredWorktrees.length === 0 ? (
          <div className="worktrees-empty">no linked worktrees</div>
        ) : visibleConfiguredWorktrees.length === 0 ? (
          <div className="worktrees-empty">no matching worktrees</div>
        ) : (
          <>
            <div className="worktrees-target-list">
              {displayedConfiguredWorktrees.map(renderWorktreeRow)}
            </div>
            {linkedLimited && (
              <div className="worktrees-show-row">
                <span>Showing {displayedConfiguredWorktrees.length} of {visibleConfiguredWorktrees.length}</span>
                <button className="btn btn-sm" onClick={() => setShowAllLinked((show) => !show)}>
                  {showAllLinked ? `Show first ${WORKTREE_SECTION_PREVIEW_LIMIT}` : `Show all ${visibleConfiguredWorktrees.length}`}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {!loading && (
        <div className={`worktrees-import-shell worktrees-discovered-shell${discoveredOpen ? " worktrees-discovered-open" : ""}`}>
          <button
            type="button"
            className="worktrees-section-header worktrees-section-toggle"
            onClick={() => setDiscoveredOpen((open) => !open)}
            aria-expanded={discoveredOpen}
          >
            <span className="worktrees-section-title">
              <span>Unlinked worktrees</span>
              <strong>{visibleImportableWorktrees.length}</strong>
            </span>
            <span className="worktrees-section-chevron" aria-hidden="true">{discoveredOpen ? "▾" : "▸"}</span>
          </button>
          {discoveredOpen && (
            <>
              {visibleImportableWorktrees.length === 0 ? (
                <div className="worktrees-empty worktrees-import-empty">
                  {importableWorktrees.length === 0 ? "no unlinked worktrees found" : "no matching worktrees"}
                </div>
              ) : (
                <>
                  <div className="worktrees-import-actions worktrees-discovered-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={importSelected}
                      disabled={selectedImportable.length === 0 || hasAliasConflict || importing}
                    >
                      {importing ? "Importing..." : selectedImportable.length > 0 ? `Import ${selectedImportable.length}` : "Import"}
                    </button>
                  </div>
                  <div className="worktrees-import-list">
                    {displayedImportableWorktrees.map((wt) => {
                      const checked = selected.has(wt.path);
                      return (
                        <label key={wt.path} className={`worktrees-import-row ${checked ? "worktrees-import-row-selected" : ""}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleWorktree(wt.path)}
                          />
                          <div className="worktrees-import-body">
                            <div className="worktrees-import-main">
                              <span className="worktrees-target-alias">{wt.repoAlias}</span>
                              <BranchLabel worktree={wt} />
                            </div>
                            <div className="worktrees-target-path" title={wt.path}>{shortPath(wt.path)}</div>
                            <WorktreeGitSummary repoPath={wt.path} refreshKey={summaryVersion} />
                            {checked && (
                              <input
                                className="form-input worktrees-alias-input"
                                value={aliases[wt.path] || ""}
                                onChange={(e) => setAliases((prev) => ({ ...prev, [wt.path]: e.target.value }))}
                                placeholder="alias"
                              />
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  {discoveredLimited && (
                    <div className="worktrees-show-row">
                      <span>Showing {displayedImportableWorktrees.length} of {visibleImportableWorktrees.length}</span>
                      <button className="btn btn-sm" onClick={() => setShowAllDiscovered((show) => !show)}>
                        {showAllDiscovered ? `Show first ${WORKTREE_SECTION_PREVIEW_LIMIT}` : `Show all ${visibleImportableWorktrees.length}`}
                      </button>
                    </div>
                  )}
                  {hasAliasConflict && (
                    <div className="form-error worktrees-error">Selected aliases must be unique.</div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Listed but not importable: these belong to a running agent and are removed
          with it. Showing them prevents the "where did my worktree go?" confusion
          without inviting an alias that would dangle. */}
      {!loading && visibleAgentWorktrees.length > 0 && (
        <div className="worktrees-import-shell">
          <div className="worktrees-import-header">
            <div>
              <span>Agent worktrees</span>
              <strong>{visibleAgentWorktrees.length}</strong>
            </div>
          </div>
          <p className="worktrees-agent-note">
            Created by Agentdock and removed when the agent stops, so they aren't imported.
          </p>
          <div className="worktrees-import-list">
            {visibleAgentWorktrees.map((wt) => (
              <div key={wt.path} className="worktrees-import-row worktrees-agent-row">
                <div className="worktrees-import-body">
                  <div className="worktrees-import-main">
                    <span className="worktrees-target-alias">{wt.repoAlias}</span>
                    <BranchLabel worktree={wt} />
                    <span className="worktrees-agent-owner">{wt.agentSession}</span>
                  </div>
                  <div className="worktrees-target-path" title={wt.path}>{shortPath(wt.path)}</div>
                  <WorktreeGitSummary repoPath={wt.path} refreshKey={summaryVersion} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
