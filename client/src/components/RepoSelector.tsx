import { useState, useEffect } from "react";
import { fetchRepos } from "../api";
import type { RepoConfig } from "../types";

interface Props {
  selected: string[];
  onChange: (selected: string[]) => void;
}

export function RepoSelector({ selected, onChange }: Props) {
  const [repos, setRepos] = useState<RepoConfig[]>([]);

  useEffect(() => {
    fetchRepos().then(setRepos).catch(() => {});
  }, []);

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
      <div className="repo-list">
        {repos.map((repo) => (
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
      </div>
    </div>
  );
}
