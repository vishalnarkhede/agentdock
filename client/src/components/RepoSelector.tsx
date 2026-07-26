import { useState, useEffect, useMemo, useRef } from "react";
import { fetchRepoWorktrees, fetchRepos } from "../api";
import type { RepoConfig, RepoWorktreeInfo } from "../types";

const MAX_RECENT = 5;

type TargetFilter = "all" | "repos" | "worktrees";
type TargetKind = "repo" | "worktree";

export function saveRecentRepos(aliases: string[], currentRecent: string[] = []): string[] {
  const updated = [...new Set([...aliases, ...currentRecent])].slice(0, MAX_RECENT);
  // Fire-and-forget - caller handles persistence
  return updated;
}

interface Props {
  selected: string[];
  onChange: (selected: string[]) => void;
  recentRepos?: string[];
  autoFocus?: boolean;
}

interface TargetItem {
  repo: RepoConfig;
  worktree?: RepoWorktreeInfo;
  kind: TargetKind;
  recent: boolean;
}

function shortPath(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+\//, "~/")
    .replace(/^\/home\/[^/]+\//, "~/");
}

function branchLabel(worktree?: RepoWorktreeInfo): string {
  if (!worktree) return "";
  return worktree.branch || "detached";
}

function itemMatches(item: TargetItem, query: string): boolean {
  if (!query) return true;
  const wt = item.worktree;
  return [
    item.repo.alias,
    item.repo.path,
    item.repo.remote,
    item.kind,
    wt?.repoAlias,
    wt?.branch,
    wt?.path,
    wt?.remote,
  ].some((value) => (value || "").toLowerCase().includes(query));
}

function itemRank(item: TargetItem, selected: Set<string>, recentRepos: string[], query: string): number[] {
  const alias = item.repo.alias.toLowerCase();
  return [
    selected.has(item.repo.alias) ? 0 : 1,
    query && alias.startsWith(query) ? 0 : 1,
    item.kind === "worktree" ? 0 : 1,
    item.recent ? 0 : 1,
    item.recent ? recentRepos.indexOf(item.repo.alias) : 999,
  ];
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export function RepoSelector({ selected, onChange, recentRepos = [], autoFocus = false }: Props) {
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [worktrees, setWorktrees] = useState<RepoWorktreeInfo[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TargetFilter>("all");
  const [loadError, setLoadError] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchRepos(),
      fetchRepoWorktrees().catch(() => [] as RepoWorktreeInfo[]),
    ])
      .then(([nextRepos, nextWorktrees]) => {
        if (cancelled) return;
        setRepos(nextRepos);
        setWorktrees(nextWorktrees);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    const id = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [autoFocus]);

  const linkedWorktreeByPath = useMemo(() => new Map(
    worktrees
      .filter((wt) => wt.configured && !wt.bare && !wt.isMain)
      .map((wt) => [wt.path, wt]),
  ), [worktrees]);

  const bareSourcePaths = useMemo(() => new Set(
    worktrees
      .filter((wt) => wt.configured && wt.bare)
      .map((wt) => wt.path),
  ), [worktrees]);

  const selectableRepos = useMemo(
    () => repos.filter((repo) => !bareSourcePaths.has(repo.path)),
    [repos, bareSourcePaths],
  );
  const hiddenBareCount = repos.length - selectableRepos.length;

  const targetItems = useMemo<TargetItem[]>(() => selectableRepos.map((repo) => {
    const worktree = linkedWorktreeByPath.get(repo.path);
    return {
      repo,
      worktree,
      kind: worktree ? "worktree" : "repo",
      recent: !search.trim() && recentRepos.includes(repo.alias),
    };
  }), [selectableRepos, linkedWorktreeByPath, recentRepos, search]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const normalizedSearch = search.trim().toLowerCase();
  const repoCount = targetItems.filter((item) => item.kind === "repo").length;
  const worktreeCount = targetItems.length - repoCount;

  const visibleItems = useMemo(() => targetItems
    .filter((item) => filter === "all" || (filter === "repos" ? item.kind === "repo" : item.kind === "worktree"))
    .filter((item) => itemMatches(item, normalizedSearch))
    .sort((a, b) => compareRank(
      itemRank(a, selectedSet, recentRepos, normalizedSearch),
      itemRank(b, selectedSet, recentRepos, normalizedSearch),
    ) || a.repo.alias.localeCompare(b.repo.alias)),
  [filter, normalizedSearch, recentRepos, selectedSet, targetItems]);

  const visibleWorktrees = visibleItems.filter((item) => item.kind === "worktree");
  const visibleRepos = visibleItems.filter((item) => item.kind === "repo");

  const toggle = (alias: string) => {
    if (selected.includes(alias)) {
      onChange(selected.filter((s) => s !== alias));
    } else {
      onChange([...selected, alias]);
    }
  };

  const renderTargetItem = (item: TargetItem) => {
    const { repo, worktree, kind, recent } = item;
    const selectedItem = selected.includes(repo.alias);
    const branch = branchLabel(worktree);
    const title = kind === "worktree"
      ? `${repo.alias}: ${worktree?.repoAlias || "worktree"} / ${branch} - ${repo.path}`
      : `${repo.alias}: ${repo.path}`;

    return (
      <label
        key={repo.alias}
        className={`repo-item ${selectedItem ? "repo-item-selected" : ""}`}
        title={title}
      >
        <input
          type="checkbox"
          checked={selectedItem}
          onChange={() => toggle(repo.alias)}
        />
        <span className="repo-item-main">
          <span className="repo-alias-row">
            <span className="repo-alias">{repo.alias}</span>
            <span className={`repo-kind-badge repo-kind-${kind}`}>{kind === "worktree" ? "worktree" : "repo"}</span>
            {recent && <span className="repo-recent-badge">recent</span>}
          </span>
          {kind === "worktree" ? (
            <span className="repo-path repo-worktree-detail">
              <span className="repo-source-name">{worktree?.repoAlias || "source"}</span>
              <span className={`branch-label repo-branch-name${branch === "detached" ? " branch-label-muted" : ""}`}>{branch}</span>
              <span className="repo-path-text">{shortPath(repo.path)}</span>
            </span>
          ) : (
            <span className="repo-path">{shortPath(repo.path)}</span>
          )}
        </span>
      </label>
    );
  };

  const renderGroup = (label: string, items: TargetItem[]) => {
    if (items.length === 0) return null;
    return (
      <>
        <div className="repo-group-label">{label}</div>
        {items.map(renderTargetItem)}
      </>
    );
  };

  return (
    <div className="repo-selector">
      <div className="repo-selector-header">
        <label className="form-label">Target</label>
        {selected.length > 0 && (
          <button type="button" className="repo-clear-btn" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>

      <input
        ref={searchRef}
        type="text"
        className="repo-search-inline"
        placeholder="Search repos, worktrees, branches..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="repo-target-tabs" role="tablist" aria-label="Target type">
        <button
          type="button"
          className={`repo-target-tab ${filter === "all" ? "repo-target-tab-active" : ""}`}
          onClick={() => setFilter("all")}
          role="tab"
          aria-selected={filter === "all"}
        >
          All <span>{targetItems.length}</span>
        </button>
        <button
          type="button"
          className={`repo-target-tab ${filter === "repos" ? "repo-target-tab-active" : ""}`}
          onClick={() => setFilter("repos")}
          role="tab"
          aria-selected={filter === "repos"}
        >
          Repos <span>{repoCount}</span>
        </button>
        <button
          type="button"
          className={`repo-target-tab ${filter === "worktrees" ? "repo-target-tab-active" : ""}`}
          onClick={() => setFilter("worktrees")}
          role="tab"
          aria-selected={filter === "worktrees"}
          disabled={worktreeCount === 0}
        >
          Worktrees <span>{worktreeCount}</span>
        </button>
      </div>

      {selected.length > 0 && (
        <div className="repo-selected-summary" title={selected.join(", ")}>
          {selected.map((alias) => <span key={alias}>{alias}</span>)}
        </div>
      )}

      <div className="repo-list">
        {filter === "repos" ? renderGroup("Repos", visibleRepos) : null}
        {filter === "worktrees" ? renderGroup("Worktrees", visibleWorktrees) : null}
        {filter === "all" && renderGroup("Worktrees", visibleWorktrees)}
        {filter === "all" && renderGroup("Repos", visibleRepos)}
        {visibleItems.length === 0 && normalizedSearch && (
          <p className="form-hint repo-empty">No targets matching "{search}"</p>
        )}
        {visibleItems.length === 0 && !normalizedSearch && filter === "worktrees" && (
          <p className="form-hint repo-empty">No linked worktrees</p>
        )}
        {visibleItems.length === 0 && !normalizedSearch && hiddenBareCount > 0 && filter !== "worktrees" && (
          <p className="form-hint repo-empty">Only source repos are configured. Import a worktree from Settings first.</p>
        )}
        {loadError && selectableRepos.length === 0 && (
          <p className="form-error repo-empty">Failed to load repos. Is the server running?</p>
        )}
      </div>

      {hiddenBareCount > 0 && (
        <p className="repo-hidden-sources">{hiddenBareCount} source repo{hiddenBareCount === 1 ? "" : "s"} hidden from agent targets</p>
      )}
    </div>
  );
}
