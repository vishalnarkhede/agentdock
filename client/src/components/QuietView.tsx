import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";
import "../styles/quiet.css";

/* ── Housekeeping data (GET /api/housekeeping) ────────────────────────────── */

interface WorktreeFact {
  repo: string;
  path: string;
  branch: string | null;
  bytes: number;
  locked: boolean;
  missing: boolean;
}

interface HousekeepingReport {
  repos: { alias: string; path: string; defaultRef: string | null; error?: string }[];
  mergedWorktrees: WorktreeFact[];
  unmergedWorktrees: WorktreeFact[];
  missingWorktrees: WorktreeFact[];
  staleBranches: { repo: string; branch: string }[];
  missingInstall: WorktreeFact[];
  reclaimableBytes: number;
  counts: {
    repos: number;
    scanErrors: number;
    merged: number;
    unmerged: number;
    missing: number;
    staleBranches: number;
    missingInstall: number;
  };
  scannedAt: string;
}

export interface QuietViewProps {
  /** Stopped sessions whose history is intact. Empty is a valid state. */
  staleSessions: { name: string; displayName: string; repo: string; age: string }[];
  /** Restore one session. The row shows its own optimistic pending state. */
  onRestore: (name: string) => void;
  /** Restore every session not already restored in this pass. */
  onRestoreAll: () => void;
  /**
   * Start something new. "ticket" resumes the last ticket, "repo" opens a
   * worktree in the most-used repo, "chat" is a session with no repo at all.
   */
  onStart: (kind: "ticket" | "repo" | "chat") => void;
}

/** Decimal units, so the figure reads the same as it does in Finder. */
function bytesLabel(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/**
 * The chores worth naming, each with the fact that makes it worth doing.
 * Only non-zero counts are rendered — a clean machine should say so once
 * rather than show three zeroes.
 */
function chores(hk: HousekeepingReport): {
  id: string;
  num: number;
  title: string;
  detail: string;
  action: string;
  tone: "ready" | "blocked";
}[] {
  const out: ReturnType<typeof chores> = [];
  const { merged, staleBranches, missingInstall } = hk.counts;

  if (merged > 0) {
    const size = hk.reclaimableBytes > 0 ? ` taking ${bytesLabel(hk.reclaimableBytes)}` : "";
    out.push({
      id: "merged",
      num: merged,
      title: `merged ${plural(merged, "worktree")}`,
      detail: `Their branches are already in the default branch. The ${plural(merged, "directory", "directories")} ${plural(merged, "is", "are")} still on disk${size}, and they keep appearing in repo pickers.`,
      action: `Remove all ${merged}`,
      tone: "ready",
    });
  }
  if (staleBranches > 0) {
    out.push({
      id: "branches",
      num: staleBranches,
      title: "wt-* branches",
      detail: `Left behind by sessions that were killed rather than shipped. None has unmerged commits, and none is checked out.`,
      action: `Delete the ${staleBranches} ${plural(staleBranches, "branch", "branches")}`,
      tone: "ready",
    });
  }
  if (missingInstall > 0) {
    out.push({
      id: "install",
      num: missingInstall,
      title: `${plural(missingInstall, "worktree")} missing node_modules`,
      detail:
        "A fresh worktree has no install. An agent that starts there will spend its first two minutes on npm install unless you pre-warm it.",
      action: `Run install in all ${missingInstall}`,
      tone: "blocked",
    });
  }
  return out;
}

const STARTS: { kind: "ticket" | "repo" | "chat"; icon: IconName; title: string; sub: string; key: string; tone: string }[] = [
  {
    kind: "ticket",
    icon: "repo",
    title: "Pick up where you left off",
    sub: "The ticket you were on when the last session stopped.",
    key: "T",
    tone: "primary",
  },
  {
    kind: "repo",
    icon: "branch",
    title: "Start in a repo",
    sub: "Your most-used repo. New worktree off the default branch.",
    key: "R",
    tone: "ready",
  },
  {
    kind: "chat",
    icon: "sparkle",
    title: "Just talk it through",
    sub: "No repo, no worktree. For thinking out loud.",
    key: "G",
    tone: "blocked",
  },
];

/**
 * The quiet state — what the dashboard shows when no agent is running,
 * blocked, or waiting for review.
 *
 * An empty queue is the one moment the tool has the user's full attention and
 * nothing urgent to spend it on, so it spends it on the two things that
 * otherwise never get looked at: the sessions that stopped without being
 * finished, and the worktrees and branches those sessions left on disk.
 *
 * Session data arrives as props. The housekeeping facts are fetched here and
 * degrade to nothing on failure — the empty state must never wait on a disk
 * scan, and the endpoint may not be mounted yet.
 */
export function QuietView({ staleSessions, onRestore, onRestoreAll, onStart }: QuietViewProps) {
  const [hk, setHk] = useState<HousekeepingReport | null>(null);
  // The scan walks every worktree on disk, which takes seconds on a machine
  // with many repos, so the column says what it is doing rather than sitting
  // empty. It never gates anything else on the page.
  const [counting, setCounting] = useState(true);
  const [restored, setRestored] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    fetch("/api/housekeeping")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: HousekeepingReport) => {
        if (alive && d && d.counts) setHk(d);
      })
      .catch(() => {
        /* housekeeping is a bonus, never a blocker */
      })
      .finally(() => {
        if (alive) setCounting(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const remaining = staleSessions.filter((s) => !restored[s.name]).length;

  const restoreOne = (name: string) => {
    setRestored((prev) => ({ ...prev, [name]: true }));
    onRestore(name);
  };
  const restoreAll = () => {
    setRestored(Object.fromEntries(staleSessions.map((s) => [s.name, true])));
    onRestoreAll();
  };

  const list = hk ? chores(hk) : [];
  const footNote =
    hk && (hk.counts.merged > 0 || hk.counts.staleBranches > 0)
      ? `${hk.counts.merged} merged ${plural(hk.counts.merged, "worktree")} and ${hk.counts.staleBranches} stale ${plural(hk.counts.staleBranches, "branch", "branches")} are still on disk.`
      : null;

  return (
    // The columns live in their own flex row: a container query can style a
    // container's descendants but never the container itself, so the stacked
    // layout has to be applied one level in.
    <div className="qv">
     <div className="qv-cols">
      {/* ── Left: what stopped ─────────────────────────────────────────── */}
      <div className="qv-rail">
        <div className="qv-rail-head">
          <div className="qv-rail-title">
            <span className="qv-dot qv-dot-idle" />
            <span className="qv-label">NOTHING ACTIVE</span>
          </div>
          <p className="qv-rail-sub">No agent is running, blocked or waiting for review.</p>
        </div>

        {staleSessions.length > 0 && (
          <>
            <div className="qv-group">
              <span className="qv-dot qv-dot-stale" />
              <span className="qv-label qv-label-stale">STALE</span>
              <span className="qv-mono">{remaining}</span>
              {remaining > 0 ? (
                <button type="button" className="qv-link" onClick={restoreAll}>
                  Restore all {remaining}
                </button>
              ) : (
                <span className="qv-link qv-link-done">all restored</span>
              )}
            </div>
            <div className="qv-rows">
              {staleSessions.map((s) => {
                const pending = !!restored[s.name];
                return (
                  <div key={s.name} className={`qv-row${pending ? " qv-row-pending" : ""}`}>
                    <div className="qv-row-top">
                      <span className="qv-ring" />
                      <span className="qv-row-name">{s.displayName}</span>
                      <span className="qv-mono qv-row-age">{s.age}</span>
                    </div>
                    <div className="qv-row-bottom">
                      <span className="qv-mono qv-row-repo">{s.repo}</span>
                      <span className="qv-row-why">{pending ? "restoring" : "stopped"}</span>
                      <button
                        type="button"
                        className="qv-restore"
                        disabled={pending}
                        onClick={() => restoreOne(s.name)}
                      >
                        {pending ? "restoring…" : "Restore"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {footNote && (
          <div className="qv-foot">
            <Icon name="layers" size={14} />
            <span>{footNote}</span>
          </div>
        )}
      </div>

      {/* ── Centre: nothing is waiting ──────────────────────────────────── */}
      <div className="qv-main">
        <div className="qv-main-inner">
          <h1 className="qv-title">Nothing is waiting on you</h1>
          <p className="qv-lede">
            {staleSessions.length > 0
              ? `${staleSessions.length} ${plural(staleSessions.length, "session")} stopped without finishing — the history is intact and ${plural(staleSessions.length, "it", "they")} can be restored. Or start something.`
              : "The queue is empty and nothing is left half-done. Start something."}
          </p>

          <div className="qv-starts">
            {STARTS.map((a) => (
              <button
                key={a.kind}
                type="button"
                className="qv-start"
                onClick={() => onStart(a.kind)}
              >
                <span className={`qv-start-icon qv-tone-${a.tone}`}>
                  <Icon name={a.icon} size={17} />
                </span>
                <span className="qv-start-text">
                  <span className="qv-start-title">{a.title}</span>
                  <span className="qv-start-sub">{a.sub}</span>
                </span>
                <span className="qv-key" aria-hidden="true">
                  {a.key}
                </span>
              </button>
            ))}
          </div>

          <p className="qv-hint">
            <span className="qv-key">⌘K</span>
            <span>opens the same list from anywhere, including mid-session.</span>
          </p>
        </div>
      </div>

      {/* ── Right: housekeeping ────────────────────────────────────────── */}
      <div className="qv-chores">
        <div className="qv-chores-head">
          <div className="qv-label">HOUSEKEEPING</div>
          <p className="qv-rail-sub">
            Worktrees are cheap to make and easy to forget. This is the only place that counts them.
          </p>
        </div>
        <div className="qv-chores-body">
          {list.map((c) => (
            <div key={c.id} className="qv-chore">
              <div className="qv-chore-top">
                <span className={`qv-chore-num qv-num-${c.tone}`}>{c.num}</span>
                <span className="qv-chore-title">{c.title}</span>
              </div>
              <p className="qv-chore-detail">{c.detail}</p>
              {/* Removing worktrees and deleting branches is destructive and
                  not wired up: the button names the action and stays inert. */}
              <button type="button" className="qv-chore-act" disabled title="Not available yet">
                {c.action}
              </button>
            </div>
          ))}
          {counting && <p className="qv-chores-clean">Counting worktrees on disk&hellip;</p>}
          {!counting && hk && list.length === 0 && (
            <p className="qv-chores-clean">
              No merged worktrees, no stale branches, nothing missing an install.
            </p>
          )}

          <div className="qv-threshold">
            <div className="qv-threshold-top">
              <Icon name="clock" size={14} />
              <span>Mark idle sessions stale after</span>
              <span className="qv-mono qv-threshold-value">24h</span>
            </div>
            <p className="qv-threshold-sub">
              Stale sessions drop out of the queue so they stop counting against your attention.
              Nothing is killed.
            </p>
          </div>
        </div>
      </div>
     </div>
    </div>
  );
}
