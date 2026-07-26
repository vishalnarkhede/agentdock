import { useCallback, useEffect, useState } from "react";
import { fetchGitLog, type GitLogCommit, type GitLogResponse } from "../api";

interface Props {
  sessionPaths: string[];
}

function repoLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function formatRefs(refs: string): string[] {
  return refs
    .split(",")
    .map((ref) => ref.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function CommitRow({ commit }: { commit: GitLogCommit }) {
  const refs = formatRefs(commit.refs);
  return (
    <div className="git-log-row">
      <div className="git-log-hash" title={commit.hash}>{commit.shortHash}</div>
      <div className="git-log-body">
        <div className="git-log-subject">{commit.subject}</div>
        <div className="git-log-meta">
          <span>{commit.author}</span>
          <span>{commit.date}</span>
          {refs.map((ref) => (
            <span key={ref} className="git-log-ref">{ref}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function RepoGitLog({ sessionPath, showRepoLabel }: { sessionPath: string; showRepoLabel: boolean }) {
  const [data, setData] = useState<GitLogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    fetchGitLog(sessionPath)
      .then((result) => setData(result))
      .catch((err: any) => setError(err.message || "Failed to fetch git log"))
      .finally(() => setLoading(false));
  }, [sessionPath]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const label = repoLabel(sessionPath);

  return (
    <div className="repo-git-log">
      <div className="git-log-header">
        <div className="git-log-header-left">
          {showRepoLabel && <span className="repo-changes-name">{label}</span>}
          <span className={`branch-label changes-branch${data?.branch ? "" : " branch-label-muted"}`}>{data?.branch || "unknown"}</span>
          {data?.upstream && <span className="git-log-upstream">{data.upstream}</span>}
        </div>
        <button className="btn btn-sm changes-refresh-btn" onClick={load} title="Refresh">↻</button>
      </div>

      {loading ? (
        <div className="plan-loading">loading git log...</div>
      ) : error ? (
        <div className="form-error">{error}</div>
      ) : !data || data.commits.length === 0 ? (
        <div className="plan-empty">no commits found</div>
      ) : (
        <div className="git-log-list">
          {data.commits.map((commit) => (
            <CommitRow key={commit.hash} commit={commit} />
          ))}
        </div>
      )}
    </div>
  );
}

export function GitLogView({ sessionPaths }: Props) {
  if (sessionPaths.length === 0) {
    return (
      <div className="git-log-view">
        <div className="plan-empty">no repo path available</div>
      </div>
    );
  }

  const limitedPaths = sessionPaths.slice(0, 4);
  const multiRepo = limitedPaths.length > 1;

  return (
    <div className="git-log-view">
      {limitedPaths.map((path) => (
        <RepoGitLog key={path} sessionPath={path} showRepoLabel={multiRepo} />
      ))}
    </div>
  );
}
