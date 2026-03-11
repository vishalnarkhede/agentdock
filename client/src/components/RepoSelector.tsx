import { useState, useEffect, useMemo } from "react";
import { Search } from "lucide-react";
import { fetchRepos } from "../api";
import type { RepoConfig } from "../types";

const INITIAL_LIMIT = 10;

interface Props {
  selected: string[];
  onChange: (selected: string[]) => void;
}

export function RepoSelector({ selected, onChange }: Props) {
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetchRepos().then(setRepos).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    const matches = repos.filter(
      (r) =>
        r.alias.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q),
    );
    // Sort: aliases starting with the query first, then the rest
    matches.sort((a, b) => {
      const aStarts = a.alias.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.alias.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts;
    });
    return matches;
  }, [repos, search]);

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
      <label className="form-label">Repositories</label>
      <p className="form-hint">Select which repos the agent will work in. Multiple repos create one session with access to all of them.</p>
      {repos.length > INITIAL_LIMIT && (
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: "var(--text-dim)" }}
          />
          <input
            type="text"
            className="form-input repo-search"
            style={{ paddingLeft: 32 }}
            placeholder="Search repos..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      <div className="repo-list">
        {visible.map((repo) => (
          <label key={repo.alias} className="repo-item">
            <input
              type="checkbox"
              checked={selected.includes(repo.alias)}
              onChange={() => toggle(repo.alias)}
            />
            <span className="repo-alias">{repo.alias}</span>
            <span className="repo-path">
              {repo.path.replace(/^\/Users\/[^/]+\//, "~/")}
            </span>
          </label>
        ))}
        {visible.length === 0 && search.trim() && (
          <p className="form-hint" style={{ padding: "8px 12px" }}>No repos matching "{search}"</p>
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
