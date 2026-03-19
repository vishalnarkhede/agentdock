import { useState, useEffect, useMemo } from "react";
import { fetchRepos } from "../api";
import type { RepoConfig } from "../types";

const INITIAL_LIMIT = 10;
const MAX_RECENT = 5;

export function saveRecentRepos(aliases: string[], currentRecent: string[] = []): string[] {
  const updated = [...new Set([...aliases, ...currentRecent])].slice(0, MAX_RECENT);
  // Fire-and-forget — caller handles persistence
  return updated;
}

interface Props {
  selected: string[];
  onChange: (selected: string[]) => void;
  recentRepos?: string[];
}

export function RepoSelector({ selected, onChange, recentRepos = [] }: Props) {
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    fetchRepos()
      .then(setRepos)
      .catch(() => setLoadError(true));
  }, []);

  const filtered = useMemo(() => {
    let list = repos;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = repos.filter(
        (r) =>
          r.alias.toLowerCase().includes(q) ||
          r.path.toLowerCase().includes(q),
      );
      // Sort: aliases starting with the query first, then the rest
      list.sort((a, b) => {
        const aStarts = a.alias.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.alias.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts;
      });
    } else {
      // Sort: selected first, then recent, then the rest
      const selectedSet = new Set(selected);
      const recentSet = new Set(recentRepos);
      list = [...list].sort((a, b) => {
        const aSelected = selectedSet.has(a.alias) ? 0 : 1;
        const bSelected = selectedSet.has(b.alias) ? 0 : 1;
        if (aSelected !== bSelected) return aSelected - bSelected;
        const aRecent = recentSet.has(a.alias) ? 0 : 1;
        const bRecent = recentSet.has(b.alias) ? 0 : 1;
        if (aRecent !== bRecent) return aRecent - bRecent;
        // Preserve recent order among recent repos
        if (aRecent === 0 && bRecent === 0) {
          return recentRepos.indexOf(a.alias) - recentRepos.indexOf(b.alias);
        }
        return 0;
      });
    }
    return list;
  }, [repos, search, recentRepos, selected]);

  const isSearching = search.trim().length > 0;
  const showAll = expanded || isSearching;
  const visible = showAll ? filtered : filtered.slice(0, INITIAL_LIMIT);
  const hiddenCount = filtered.length - INITIAL_LIMIT;

  const toggle = (alias: string) => {
    if (selected.includes(alias)) {
      onChange(selected.filter((s) => s !== alias));
    } else {
      onChange([...selected, alias]);
    }
  };

  return (
    <div className="repo-selector">
      <div className="repo-selector-header">
        <label className="form-label">Repositories</label>
        {repos.length > INITIAL_LIMIT && (
          <input
            type="text"
            className="repo-search-inline"
            placeholder="Filter..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
      </div>
      {selected.length > 0 && (
        <div className="repo-selected-summary">
          {selected.length} selected: {selected.join(", ")}
        </div>
      )}
      <div className="repo-list">
        {visible.map((repo, i) => {
          const isRecent = !search.trim() && recentRepos.includes(repo.alias);
          const isLastRecent = isRecent && (i + 1 >= visible.length || !recentRepos.includes(visible[i + 1]?.alias));
          return (
            <div key={repo.alias}>
              <label className={`repo-item ${selected.includes(repo.alias) ? "repo-item-selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={selected.includes(repo.alias)}
                  onChange={() => toggle(repo.alias)}
                />
                <span className="repo-alias">
                  {repo.alias}
                  {isRecent && <span className="repo-recent-badge">recent</span>}
                </span>
                <span className="repo-path">
                  {repo.path.replace(/^\/Users\/[^/]+\//, "~/")}
                </span>
              </label>
              {isLastRecent && <div className="repo-recent-divider" />}
            </div>
          );
        })}
        {visible.length === 0 && search.trim() && (
          <p className="form-hint" style={{ padding: "8px 12px" }}>No repos matching "{search}"</p>
        )}
        {loadError && repos.length === 0 && (
          <p className="form-error" style={{ padding: "8px 12px" }}>Failed to load repos. Is the server running?</p>
        )}
      </div>
      {!isSearching && hiddenCount > 0 && !expanded && (
        <button
          type="button"
          className="btn btn-sm repo-show-more"
          onClick={() => setExpanded(true)}
        >
          Show {hiddenCount} more...
        </button>
      )}
      {!isSearching && expanded && repos.length > INITIAL_LIMIT && (
        <button
          type="button"
          className="btn btn-sm repo-show-more"
          onClick={() => setExpanded(false)}
        >
          Show less
        </button>
      )}
    </div>
  );
}
