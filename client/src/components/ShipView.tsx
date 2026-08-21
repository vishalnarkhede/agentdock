import { useEffect, useState } from "react";
import { fetchShipPlan, type ShipPlan } from "../api";
import { Icon } from "./Icon";
import "../styles/ship.css";

/**
 * The merge queue.
 *
 * Merging several agent branches at once is where parallel work actually
 * bites: two worktrees that touched the same file produce a conflict that is
 * invisible until the second merge. This states the order, the reason for it,
 * and which pairs collide — before anything is merged.
 *
 * It plans only. Nothing here runs git.
 */
export function ShipView({ activeSession }: { activeSession: string | null }) {
  const [strategy, setStrategy] = useState<"serial" | "integration">("serial");
  const [plan, setPlan] = useState<ShipPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    fetchShipPlan(strategy)
      .then((p) => alive && setPlan(p))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [strategy]);

  if (error) return <div className="sp-empty">{error}</div>;
  if (!plan) return <div className="sp-empty">scanning worktrees…</div>;
  if (plan.items.length === 0)
    return <div className="sp-empty">No worktree has changes to merge.</div>;

  const short = activeSession?.replace(/^claude-/, "");
  const kindColor: Record<string, string> = {
    merge: "var(--intent-primary)",
    test: "var(--status-blocked)",
    resolve: "var(--intent-danger)",
    branch: "var(--text-3)",
    cleanup: "var(--status-ready)",
  };

  return (
    <div className="sp">
      <div className="sp-head">
        <span className="sp-head-count">
          {plan.items.length} worktree{plan.items.length === 1 ? "" : "s"} with changes
        </span>
        {plan.conflicts.length > 0 && (
          <span className="sp-head-conflicts">
            <Icon name="merge" size={12} /> {plan.conflicts.length} collision
            {plan.conflicts.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="sp-strategies">
        {([
          {
            id: "serial" as const,
            title: "One at a time",
            detail:
              "Each merge sees the one before it, so a conflict surfaces alone. Tests run between every step and a failure stops the queue.",
          },
          {
            id: "integration" as const,
            title: "Integration branch first",
            detail:
              "Collect everything on one branch, resolve there once, test once, then a single merge. Better when many branches touch each other.",
          },
        ]).map((s) => (
          <button
            key={s.id}
            className={`sp-strategy ${strategy === s.id ? "sp-strategy-on" : ""}`}
            onClick={() => setStrategy(s.id)}
            aria-pressed={strategy === s.id}
          >
            <span className="sp-strategy-title">
              <span className="sp-radio" />
              {s.title}
              {s.id === "serial" && <span className="sp-rec">recommended</span>}
            </span>
            <span className="sp-strategy-detail">{s.detail}</span>
          </button>
        ))}
      </div>

      {plan.conflicts.length > 0 && (
        <div className="sp-section">
          <div className="sp-section-head">Branches that collide</div>
          {plan.conflicts.map((c) => (
            <div key={c.sessions.join("|")} className="sp-conflict">
              <Icon name="alert" size={13} className="sp-conflict-icon" />
              <div className="sp-conflict-body">
                <div className="sp-conflict-pair">
                  <span className="sp-mono">{c.sessions[0]}</span>
                  <span className="sp-x">and</span>
                  <span className="sp-mono">{c.sessions[1]}</span>
                </div>
                <div className="sp-conflict-files">
                  {c.files.length} shared file{c.files.length === 1 ? "" : "s"} &middot;{" "}
                  {c.files.slice(0, 2).map((f) => f.split("/").pop()).join(", ")}
                  {c.files.length > 2 && ` +${c.files.length - 2}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="sp-section">
        <div className="sp-section-head">Queue</div>
        {plan.items.map((it) => (
          <div
            key={it.session}
            className={`sp-item ${it.session === short ? "sp-item-active" : ""}`}
          >
            <div className="sp-item-top">
              <span className="sp-item-name">{it.session}</span>
              <span className="sp-item-files">{it.fileCount}f</span>
            </div>
            <div className="sp-item-branch">
              <Icon name="branch" size={11} />
              <span className="sp-mono">{it.branch}</span>
              <span className="sp-arrow">&rarr;</span>
              <span className="sp-mono sp-target">{it.target}</span>
              {it.repos > 1 && <span className="sp-repos">{it.repos} repos</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="sp-section">
        <div className="sp-section-head">
          Run order
          <span className="sp-section-sub">{plan.steps.length} steps</span>
        </div>
        <ol className="sp-steps">
          {plan.steps.map((s, i) => (
            <li key={i} className="sp-step">
              <span className="sp-node" style={{ background: kindColor[s.kind] }} />
              <span className="sp-step-body">
                <span className="sp-step-text">{s.text}</span>
                {s.note && <span className="sp-step-note">{s.note}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="sp-foot">
        <Icon name="alert" size={13} className="sp-foot-icon" />
        <span>
          This plans the merge; it does not run it. Executing merges across live worktrees
          isn&rsquo;t wired up — do it yourself, in this order.
        </span>
      </div>
    </div>
  );
}
