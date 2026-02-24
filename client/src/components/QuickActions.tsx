import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { createSession, fetchRepos, slackToFix, fetchIntegrations, fetchDbShards, type IntegrationStatus, type DbShardInfo } from "../api";
import type { RepoConfig } from "../types";

type ActionType = "review-pr" | "fix-comments" | "ticket" | "fix-ci" | "customer" | "slack" | "merge" | null;

const ACTIONS: { type: ActionType & string; label: string; hint: string }[] = [
  { type: "review-pr", label: "review pr", hint: "paste a PR url" },
  { type: "fix-comments", label: "fix comments", hint: "paste your PR url" },
  { type: "ticket", label: "ticket -> pr", hint: "ticket id e.g. PROJ-123" },
  { type: "fix-ci", label: "fix ci", hint: "paste a PR url" },
  { type: "customer", label: "customer issue", hint: "paste their message" },
  { type: "slack", label: "slack -> fix", hint: "paste slack message link" },
  { type: "merge", label: "merge pr", hint: "paste a PR url" },
];

function detectRepoFromUrl(url: string, repos: RepoConfig[]): string | null {
  for (const repo of repos) {
    if (repo.remote && url.includes(repo.remote.replace("https://github.com/", ""))) {
      return repo.alias;
    }
  }
  return null;
}

function buildPrompt(type: ActionType, input: string, opts?: { shard?: string; customerId?: string }): string {
  switch (type) {
    case "review-pr":
      return [
        `Review this pull request thoroughly.`,
        `Use \`gh pr diff ${input}\` to see changes and \`gh pr view ${input}\` for context.`,
        `Check for bugs, security issues, performance problems, and code style.`,
        `Write out your full review with comments for each file.`,
        `IMPORTANT: Do NOT post the review on the PR. Just show me the review here and wait for my explicit confirmation before posting anything with \`gh pr review\`.`,
      ].join("\n");
    case "fix-comments":
      return [
        `Check the review comments on my PR: ${input}`,
        `Use \`gh pr view ${input} --comments\` and \`gh api repos/{owner}/{repo}/pulls/{number}/comments\` to read all review comments.`,
        `Address each comment by making the necessary code changes.`,
        `Before implementing fixes, read existing code patterns in the same files — match the project's conventions for test helpers, error handling, and code style.`,
        `Verify that existing tests still pass and add new tests if needed. Match existing test patterns (framework, structure, helpers).`,
        `After fixing everything, commit and push.`,
        `Then monitor CI with \`gh pr checks <number> --watch\`. If a check fails due to your changes, fix and push. If unrelated, restart with \`gh api repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs -X POST\` (max 5 retries per flaky job).`,
      ].join("\n");
    case "fix-ci":
      return [
        `Monitor and fix CI for this pull request: ${input}`,
        ``,
        `Step 1 — Get the PR diff to understand what changed:`,
        `  gh pr diff ${input}`,
        ``,
        `Step 2 — Watch CI checks:`,
        `  gh pr checks ${input} --watch`,
        ``,
        `Step 3 — When a check fails, get the failed run ID and download logs:`,
        `  gh pr checks ${input} --json name,state,link --jq '.[] | select(.state == "FAILURE")'`,
        `  gh run view <run-id> --log-failed`,
        ``,
        `Step 4 — For each failure, determine if it's related to the PR changes:`,
        `  - If RELATED: investigate the failure logs, find the root cause in the code, implement the fix, commit and push.`,
        `  - If UNRELATED (flaky test, infra issue, pre-existing failure): restart that specific job:`,
        `    gh api repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs -X POST`,
        `    Max 3 retries per flaky job.`,
        ``,
        `Step 5 — After fixing or restarting, keep monitoring until all checks pass:`,
        `  gh pr checks ${input} --watch`,
        ``,
        `Repeat steps 3-5 until all checks are green or you've identified issues that need my input.`,
      ].join("\n");
    case "merge":
      return [
        `You are a merge queue agent. Your ONLY job is to get this PR merged: ${input}`,
        ``,
        `RULES:`,
        `- Do NOT modify any code. You are not here to fix bugs or write code.`,
        `- If a CI failure is clearly caused by the PR's changes, STOP and report it. Do not attempt to fix code.`,
        ``,
        `SETUP:`,
        `- Run: gh pr view ${input} --json baseRefName,headRefName,headRepository,headRepositoryOwner,number`,
        `- Extract the owner, repo, base branch, head branch, and PR number.`,
        `- Navigate to the repo so you can run git commands.`,
        ``,
        `WORKFLOW — run these two tasks in an interleaved loop:`,
        ``,
        `TASK A: KEEP BRANCH UP TO DATE (check every 60 seconds)`,
        `  1. Run: git fetch origin {base}`,
        `  2. Check if branch is behind: git log HEAD..origin/{base} --oneline`,
        `  3. If behind (any output):`,
        `     - git merge origin/{base} && git push`,
        `     - This will trigger new CI. That's fine — go back to waiting.`,
        `  4. If not behind: do nothing, check again in 60s.`,
        ``,
        `TASK B: MONITOR CI AND HANDLE RESULTS`,
        `  1. Run: gh pr checks ${input} --watch`,
        `     This blocks until all checks complete (pass or fail).`,
        `  2. When checks complete, evaluate results:`,
        `     Run: gh pr checks ${input} --json name,state,link --jq '.[] | select(.state != "SUCCESS" and .state != "SKIPPED")'`,
        `  3. For each failed check:`,
        `     a. Extract run ID from the check URL.`,
        `     b. Download logs: gh run view {run_id} --log-failed 2>&1 | tail -100`,
        `     c. Compare with PR diff: gh pr diff ${input}`,
        `     d. If failure is UNRELATED to PR changes (flaky test, infra issue):`,
        `        - Restart: gh api repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs -X POST`,
        `        - Track retry count per job name. Max 5 retries per unique job.`,
        `        - Go back to step 1 (monitor again).`,
        `     e. If failure IS related to PR changes:`,
        `        - Report the failure details and STOP.`,
        `  4. If ALL checks pass:`,
        `     Run: gh pr view ${input} --json reviewDecision,mergeable,mergeStateStatus`,
        `     - If approved and mergeable: gh pr merge ${input} --squash`,
        `     - If merge succeeds: report success and STOP.`,
        `     - If not approved: report "CI green, waiting for approval" and go back to step 1.`,
        ``,
        `IMPORTANT: Since you can't literally run two tasks concurrently, interleave them:`,
        `- Start CI watch in background or use polling (gh pr checks ${input} --json ... every 30s)`,
        `- Between polls, check if branch needs updating`,
        `- This ensures you merge base ASAP when master moves, without waiting for CI to finish`,
        ``,
        `STOP CONDITIONS:`,
        `- PR is merged → report success`,
        `- CI failure related to PR changes → report and stop`,
        `- A job has failed 5+ times → report as persistent failure and stop`,
        `- Running for 45+ minutes → report current status and stop`,
      ].join("\n");
    case "customer": {
      const lines = [
        `A customer reported the following issue:`,
        ``,
        `"${input}"`,
        ``,
      ];
      if (opts?.customerId) {
        lines.push(`App ID: ${opts.customerId}`, ``);
      }
      if (opts?.shard) {
        lines.push(
          `The customer's data is on shard: ${opts.shard}`,
          ``,
          `You have read-only access to the production database via configured database shards.`,
          `Always filter queries by the customer's identifier.`,
          ``,
          `Start by investigating the customer's config in the database, then look at the codebase to understand the behavior.`,
          ``
        );
      }
      lines.push(
        `IMPORTANT: Do NOT implement any fix yet. Your job is to INVESTIGATE ONLY.`,
        ``,
        `1. Investigate the codebase to find the root cause. Check relevant code paths, configs, and data.`,
        `2. Present your findings: explain what's happening, why, and where in the code the issue originates.`,
        `3. Determine the root cause — not everything is a bug. It could be:`,
        `   - Customer misconfiguration (wrong settings, missing setup steps)`,
        `   - Wrong expectations (feature works as designed, customer misunderstands behavior)`,
        `   - Actual bug in the code`,
        `4. Propose next steps with trade-offs. If it's a customer issue, explain what they need to change. If it's a bug, propose possible fixes.`,
        `5. STOP and wait for my confirmation before making any code changes.`,
        ``,
        `Only after I confirm the approach should you proceed to implement the fix, add tests, and raise a PR.`,
      );
      return lines.join("\n");
    }
    default:
      return input;
  }
}

function nameFromAction(type: ActionType, input: string): string {
  if (type === "merge") {
    const match = input.match(/\/pull\/(\d+)/);
    if (match) return `merge-${match[1]}`;
    return `merge-${Date.now().toString(36).slice(-4)}`;
  }
  if (type === "review-pr" || type === "fix-comments" || type === "fix-ci") {
    const match = input.match(/\/pull\/(\d+)/);
    if (match) return `${type}-${match[1]}`;
  }
  if (type === "ticket") {
    return input.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  }
  return `${type}-${Date.now().toString(36).slice(-4)}`;
}

export function QuickActions({ onCreated }: { onCreated: (sessionName?: string) => void }) {
  const navigate = useNavigate();
  const [active, setActive] = useState<ActionType>(null);
  const [input, setInput] = useState("");
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [isolated, setIsolated] = useState(false);
  const [skipPerms, setSkipPerms] = useState(false);
  const [agentType, setAgentType] = useState<"claude" | "cursor">("claude");
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [dbShards, setDbShards] = useState<DbShardInfo[]>([]);
  const [shardName, setShardName] = useState("");
  const [customerId, setCustomerId] = useState("");

  useEffect(() => {
    fetchRepos().then(setRepos);
    fetchIntegrations().then(setIntegrations).catch(() => {});
    fetchDbShards().then(setDbShards).catch(() => {});
  }, []);

  const toggleRepo = (alias: string) => {
    setSelectedRepos((prev) =>
      prev.includes(alias) ? prev.filter((r) => r !== alias) : [...prev, alias]
    );
  };

  const handleSubmit = async () => {
    if (!input.trim() || !active) return;
    setSubmitting(true);
    setError("");
    setResult(null);

    try {
      if (active === "slack") {
        const res = await slackToFix(input.trim(), selectedRepos.length > 0 ? selectedRepos : undefined);
        setResult(`${res.ticket.identifier}: ${res.ticket.title}`);
        setInput("");
        onCreated();
        setTimeout(() => {
          setActive(null);
          setResult(null);
        }, 3000);
        return;
      }

      // Build targets: user-selected repos, or auto-detect from PR URL
      let targets = [...selectedRepos];
      if (targets.length === 0 && (active === "review-pr" || active === "fix-comments" || active === "fix-ci" || active === "merge")) {
        const alias = detectRepoFromUrl(input, repos);
        if (alias) targets = [alias];
      }

      if (active === "ticket") {
        // Extract clean ticket ID from URL (e.g. PROJ-123)
        let ticketId = input.trim();
        const urlMatch = ticketId.match(/issue\/([A-Z0-9]+-\d+)/i);
        if (urlMatch) ticketId = urlMatch[1];

        const result = await createSession({
          targets,
          ticket: ticketId,
          name: ticketId.toLowerCase(),
          grouped: true,
          isolated,
          dangerouslySkipPermissions: skipPerms,
          agentType,
          sessionType: "ticket",
        });
        onCreated(result.sessions[0]);
      } else {
        const result = await createSession({
          targets,
          prompt: buildPrompt(active, input.trim(), {
            shard: shardName || undefined,
            customerId: customerId || undefined,
          }),
          name: nameFromAction(active, input.trim()),
          grouped: true,
          isolated,
          dangerouslySkipPermissions: skipPerms || active === "merge" || undefined,
          agentType,
          sessionType: active,
        });
        onCreated(result.sessions[0]);
      }
      setInput("");
      setActive(null);
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && active !== "customer") {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      handleClose();
    }
  };

  const handleClose = () => {
    setActive(null);
    setInput("");
    setError("");
    setResult(null);
    setSelectedRepos([]);
    setShardName("");
    setCustomerId("");
  };

  const activeAction = ACTIONS.find((a) => a.type === active);

  return (
    <>
      <div className="quick-actions">
        <div className="quick-actions-row">
          {ACTIONS.map((a) => {
            const disabled =
              (a.type === "ticket" && integrations && !integrations.linear.configured) ||
              (a.type === "slack" && integrations && !integrations.slack.configured);
            return (
              <button
                key={a.type}
                className={`quick-action-btn ${active === a.type ? "quick-action-active" : ""} ${disabled ? "quick-action-disabled" : ""}`}
                title={disabled ? "Configure in Settings > Setup" : undefined}
                onClick={() => {
                  if (disabled) return;
                  const next = active === a.type ? null : a.type;
                  setActive(next);
                  setInput("");
                  setError("");
                  setResult(null);
                  setSelectedRepos([]);
                  setIsolated(next === "ticket");
                  setSkipPerms(false);
                }}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      </div>

      {active && activeAction && createPortal(
        <div className="settings-overlay" onClick={handleClose}>
          <div className="settings-modal quick-action-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <span className="settings-title">{activeAction.label}</span>
              <button className="settings-close-btn" onClick={handleClose}>
                &times;
              </button>
            </div>
            <div className="settings-body">
              <div className="quick-action-modal-content">
                {result ? (
                  <div className="changes-pr-success">{result}</div>
                ) : (
                  <>
                    {active === "customer" ? (
                      <>
                        <textarea
                          className="form-textarea quick-action-input"
                          placeholder={activeAction.hint}
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                          onKeyDown={handleKeyDown}
                          rows={6}
                          autoFocus
                        />
                        <div className="quick-action-db-fields">
                          <div className="quick-action-field">
                            <label className="form-label">App ID</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="e.g. 1379765"
                              value={customerId}
                              onChange={(e) => setCustomerId(e.target.value)}
                            />
                          </div>
                          {dbShards.length > 0 && (
                            <div className="quick-action-field">
                              <label className="form-label">Database Shard</label>
                              <select
                                className="form-input"
                                value={shardName}
                                onChange={(e) => setShardName(e.target.value)}
                              >
                                <option value="">None (no DB access)</option>
                                {dbShards.map((s) => (
                                  <option key={s.name} value={s.name}>
                                    {s.name} — {s.database}@{s.host}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <input
                        type="text"
                        className="form-input quick-action-input"
                        placeholder={activeAction.hint}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        autoFocus
                      />
                    )}

                    {repos.length > 0 && (
                      <div className="quick-action-repos">
                        <div className="form-label">Repositories</div>
                        <div className="quick-repo-grid">
                          {repos.map((r) => (
                            <button
                              key={r.alias}
                              type="button"
                              className={`quick-repo-btn ${selectedRepos.includes(r.alias) ? "quick-repo-active" : ""}`}
                              onClick={() => toggleRepo(r.alias)}
                            >
                              {r.alias}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="quick-action-options">
                      <label className="quick-option-label">
                        <input
                          type="checkbox"
                          checked={isolated}
                          onChange={(e) => setIsolated(e.target.checked)}
                        />
                        <span>Isolated worktree</span>
                      </label>

                      <label className="quick-option-label">
                        <input
                          type="checkbox"
                          checked={skipPerms}
                          onChange={(e) => setSkipPerms(e.target.checked)}
                        />
                        <span>Skip permissions (yolo)</span>
                      </label>

                      <div className="quick-agent-selector-modal">
                        <span className="form-label">Agent</span>
                        <div className="quick-agent-buttons">
                          <button
                            type="button"
                            className={`quick-agent-btn-modal ${agentType === "claude" ? "quick-agent-active" : ""}`}
                            onClick={() => setAgentType("claude")}
                            title="Use Claude Code"
                          >
                            <span>🤖</span>
                            <span>Claude</span>
                          </button>
                          <button
                            type="button"
                            className={`quick-agent-btn-modal ${agentType === "cursor" ? "quick-agent-active" : ""}`}
                            onClick={() => setAgentType("cursor")}
                            title="Use Cursor Agent"
                          >
                            <span>💻</span>
                            <span>Cursor</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {error && <div className="form-error">{error}</div>}

                    <div className="quick-action-modal-actions">
                      <button
                        className="btn btn-primary"
                        onClick={handleSubmit}
                        disabled={submitting || !input.trim()}
                      >
                        {submitting ? "Launching..." : "Launch Session"}
                      </button>
                      <button
                        className="btn"
                        onClick={handleClose}
                        disabled={submitting}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
