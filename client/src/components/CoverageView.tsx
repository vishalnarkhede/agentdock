import { useEffect, useState } from "react";
import { fetchCoverage, type CoverageResult } from "../api";
import { Icon } from "./Icon";

/**
 * Plan-to-diff coverage.
 *
 * The plan and the diff both already existed; nothing joined them. Joining
 * them catches what neither the compiler nor the tests can: files the task
 * never asked for, and steps the run quietly skipped.
 */
export function CoverageView({
  sessionName,
  sessionPaths,
}: {
  sessionName: string;
  sessionPaths: string[];
}) {
  const [data, setData] = useState<CoverageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selStep, setSelStep] = useState<number | null>(null);

  useEffect(() => {
    if (sessionPaths.length === 0) return;
    let alive = true;
    setError(null);
    fetchCoverage(sessionName, sessionPaths)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [sessionName, sessionPaths.join("|")]);

  if (error) return <div className="cov-empty">{error}</div>;
  if (!data) return <div className="cov-empty">reading the plan and the diff…</div>;

  const { steps, files, stats, oversized, hasPlan } = data;
  const orphans = files.filter((f) => f.step === null);
  const mapped = files.filter((f) => f.step !== null);

  if (files.length === 0) {
    return <div className="cov-empty">Nothing has changed in this worktree yet.</div>;
  }

  return (
    <div className="cov">
      <div className="cov-stats">
        <Stat
          value={hasPlan && stats.stepsTotal > 0 ? `${stats.filesMapped} / ${stats.filesTotal}` : "—"}
          unit="files"
          label="traceable to a plan step"
        />
        <Stat
          value={String(stats.filesUnplanned)}
          unit="files"
          label="the plan never mentions"
          tone={stats.filesUnplanned > 0 ? "warn" : undefined}
        />
        <Stat
          value={String(stats.stepsGap)}
          unit="steps"
          label="planned with no code"
          tone={stats.stepsGap > 0 ? "warn" : undefined}
        />
        <Stat
          value={String(stats.linesChanged)}
          unit="lines"
          label={oversized ? "past the review threshold" : "changed"}
          tone={oversized ? "warn" : undefined}
        />
      </div>

      {oversized && (
        <div className="cov-banner">
          <Icon name="alert" size={15} />
          <span>
            {stats.linesChanged} changed lines is past the point where review works. Attention
            drops sharply above roughly 400 — this is worth splitting into more than one pass.
          </span>
        </div>
      )}

      {!hasPlan && (
        <div className="cov-banner cov-banner-neutral">
          <Icon name="alert" size={15} />
          <span>No plan file for this session, so nothing can be traced. Ask the agent to write one.</span>
        </div>
      )}
      {hasPlan && stats.stepsTotal === 0 && (
        <div className="cov-banner cov-banner-neutral">
          <Icon name="alert" size={15} />
          <span>The plan has no checklist items, so there is nothing to trace against.</span>
        </div>
      )}

      <div className="cov-cols">
        <div className="cov-col">
          <div className="cov-col-head">
            The plan it wrote
            <span className="cov-col-sub">{stats.stepsTotal} steps</span>
          </div>
          {steps.length === 0 && <div className="cov-empty-sm">no steps</div>}
          {steps.map((s) => (
            <div
              key={s.index}
              className={`cov-step cov-step-${s.state} ${selStep === s.index ? "cov-step-sel" : ""}`}
              onClick={() => setSelStep(selStep === s.index ? null : s.index)}
            >
              <Icon
                name={s.state === "covered" ? "check" : s.state === "gap" ? "circle" : "dot"}
                size={13}
                className="cov-step-mark"
              />
              <div className="cov-step-body">
                <div className="cov-step-text">{s.text}</div>
                {s.files.length > 0 && (
                  <div className="cov-step-files">{s.files.join("   ")}</div>
                )}
              </div>
              <span className="cov-step-tag">
                {s.state === "covered" ? "covered" : s.state === "gap" ? "no code" : "no code expected"}
              </span>
            </div>
          ))}
        </div>

        <div className="cov-col">
          <div className="cov-col-head">
            What it actually changed
            <span className="cov-col-sub">{files.length} files</span>
          </div>

          {orphans.length > 0 && (
            <div className="cov-group cov-group-warn">
              <div className="cov-group-head">
                <span className="cov-dot cov-dot-warn" />
                The plan never mentions these
                <span className="cov-col-sub">{orphans.length}</span>
              </div>
              {orphans.map((f) => (
                <FileRow key={f.path} file={f} dim={selStep !== null} label="no step" warn />
              ))}
            </div>
          )}

          {mapped.length > 0 && (
            <div className="cov-group">
              <div className="cov-group-head">
                <span className="cov-dot cov-dot-ok" />
                Traceable to a step
                <span className="cov-col-sub">{mapped.length}</span>
              </div>
              {mapped.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  dim={selStep !== null && f.step !== selStep}
                  label={`step ${(f.step ?? 0) + 1}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  value,
  unit,
  label,
  tone,
}: {
  value: string;
  unit: string;
  label: string;
  tone?: "warn";
}) {
  return (
    <div className="cov-stat">
      <div className="cov-stat-top">
        <span className={`cov-stat-num ${tone === "warn" ? "cov-stat-warn" : ""}`}>{value}</span>
        <span className="cov-stat-unit">{unit}</span>
      </div>
      <div className="cov-stat-label">{label}</div>
    </div>
  );
}

function FileRow({
  file,
  dim,
  label,
  warn,
}: {
  file: { path: string; plus: number; minus: number };
  dim: boolean;
  label: string;
  warn?: boolean;
}) {
  return (
    <div className={`cov-file ${warn ? "cov-file-warn" : ""} ${dim ? "cov-file-dim" : ""}`}>
      <span className="cov-file-path" title={file.path}>
        {file.path}
      </span>
      <span className="cov-file-plus">+{file.plus}</span>
      <span className="cov-file-minus">&minus;{file.minus}</span>
      <span className={`cov-file-map ${warn ? "cov-file-map-warn" : ""}`}>{label}</span>
    </div>
  );
}
