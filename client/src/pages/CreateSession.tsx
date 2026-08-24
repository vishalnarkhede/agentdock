import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  createSession,
  fetchTemplates,
  saveTemplate,
  deleteTemplate,
  fetchMetaPropertyPresets,
  saveMetaPropertyPresets,
  fetchPreferences,
  updatePreferences,
  fetchBasePath,
  fetchRepos,
  fetchMcpServers,
  fetchHookState,
  uploadFile,
  type SessionTemplate,
  type HookState,
} from "../api";
import { RepoSelector, saveRecentRepos } from "../components/RepoSelector";
import { MetaSelect } from "../components/MetaSelect";
import { parseTicketId } from "../ticket-id";
import { Icon, type IconName } from "../components/Icon";
import type { AgentType, MetaPropertyPreset, RepoConfig } from "../types";
import "../styles/create.css";

type TaskSource = "ticket" | "slack" | "blank" | "chat";

const SOURCES: { id: TaskSource; label: string; icon: IconName }[] = [
  { id: "ticket", label: "Linear ticket", icon: "repo" },
  { id: "slack", label: "Slack thread", icon: "users" },
  { id: "blank", label: "Write it", icon: "edit" },
  { id: "chat", label: "Just talk", icon: "sparkle" },
];

type StepKind = "do" | "warn" | "blocked";

interface LaunchStep {
  text: string;
  code?: string;
  kind: StepKind;
}

function aliasOf(target: string): string {
  const i = target.indexOf(":");
  return i === -1 ? target : target.slice(0, i);
}

function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+\//, "~/");
}

export function CreateSession() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [sessionName, setSessionName] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [namingTemplate, setNamingTemplate] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const grouped = true;
  const [isolated, setIsolated] = useState(false);
  const [dangerouslySkipPermissions, setDangerouslySkipPermissions] = useState(false);
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [metaPresets, setMetaPresets] = useState<MetaPropertyPreset[]>([]);
  const [metaValues, setMetaValues] = useState<Record<string, string>>({});
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
  const [primaryRepo, setPrimaryRepo] = useState<string>("");

  const [source, setSource] = useState<TaskSource>("blank");
  const [ticketDraft, setTicketDraft] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [ticketNote, setTicketNote] = useState("");
  const [ticketError, setTicketError] = useState("");
  const [slackOpen, setSlackOpen] = useState(false);
  const [slackDraft, setSlackDraft] = useState("");
  const [uploading, setUploading] = useState(false);

  const [basePath, setBasePath] = useState("");
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [linearMcp, setLinearMcp] = useState<boolean | null>(null);
  const [hookState, setHookState] = useState<HookState | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchTemplates().then(setTemplates).catch(() => {});
    fetchMetaPropertyPresets().then((presets) => {
      setMetaPresets(presets);
      // Pre-fill meta values from URL params (e.g., /create?priority=high)
      const initial: Record<string, string> = {};
      for (const p of presets) {
        const v = searchParams.get(p.key);
        if (v) initial[p.key] = v;
      }
      if (Object.keys(initial).length > 0) setMetaValues(initial);
    }).catch(() => {});
    fetchPreferences().then((p) => {
      if (p.recentRepos) setRecentRepos(p.recentRepos);
      if (p.primaryRepo) setPrimaryRepo(p.primaryRepo);
    }).catch(() => {});
    fetchBasePath().then(setBasePath).catch(() => {});
    fetchRepos().then(setRepos).catch(() => {});
    fetchMcpServers()
      .then((servers) => setLinearMcp(servers.some((s) => /linear/i.test(s.name) || s.args.some((a) => /linear/i.test(a)))))
      .catch(() => setLinearMcp(null));
    fetchHookState().then(setHookState).catch(() => setHookState(null));
  }, []);

  const ready = targets.length > 0 || source === "chat";

  const ticketLine = (id: string) =>
    linearMcp
      ? `Linear ticket ${id} — read it with your Linear MCP tools before changing anything.`
      : `Linear ticket ${id} — I have not attached its text, so ask me for anything you need from it.`;

  const attachTicket = () => {
    const id = parseTicketId(ticketDraft);
    if (!id) {
      if (ticketDraft.trim()) setTicketError("That does not contain a ticket id like MOD2-1289.");
      return;
    }
    setTicketError("");
    const line = ticketLine(id);
    setTicketId(id);
    setTicketNote(line);
    setTaskPrompt((prev) => {
      if (prev.includes(line)) return prev;
      return prev.trim() ? `${line}\n\n${prev}` : `${line}\n\nConstraint:\nDone when:`;
    });
  };

  const dismissTicket = () => {
    setTaskPrompt((prev) => prev.replace(`${ticketNote}\n\n`, "").replace(ticketNote, ""));
    setTicketId("");
    setTicketNote("");
    setTicketDraft("");
  };

  const appendSlack = () => {
    const text = slackDraft.trim();
    if (!text) return;
    setTaskPrompt((prev) => `${prev.trim() ? `${prev.trim()}\n\n` : ""}Pasted Slack thread:\n${text}`);
    setSlackDraft("");
    setSlackOpen(false);
  };

  const handleAttachFile = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      const path = await uploadFile(file);
      setTaskPrompt((prev) => `${prev.trim() ? `${prev.trim()}\n\n` : ""}Attached file, read it from ${path}`);
    } catch (err: any) {
      setError(err.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const agentCmd = useMemo(() => {
    if (agentType === "cursor") return dangerouslySkipPermissions ? "agent --yolo" : "agent";
    return dangerouslySkipPermissions
      ? "claude --dangerously-skip-permissions"
      : "claude --allowedTools Read Edit Write Glob Grep 'Bash(git:*)' …";
  }, [agentType, dangerouslySkipPermissions]);

  const steps: LaunchStep[] = useMemo(() => {
    const out: LaunchStep[] = [];
    const base = basePath || "~/projects";

    if (targets.length === 0 && source !== "chat") {
      out.push({
        text: "Pick at least one repo, or choose Just talk for a session with no repo",
        kind: "blocked",
      });
      return out;
    }

    if (targets.length === 0) {
      out.push({
        text: "No repo and no worktree",
        code: `${shortenHome(base)} · the agent starts here`,
        kind: "do",
      });
    } else if (isolated) {
      for (const t of targets) {
        const alias = aliasOf(t);
        out.push({
          text: `Create a worktree for ${alias}`,
          code: `git worktree add ${shortenHome(base)}/.worktrees/wt-<id>/${alias} -b wt-<id>`,
          kind: "do",
        });
      }
      out.push({
        text: "Copy the .env files and link node_modules into each worktree",
        code: "no dependency install — node_modules is symlinked from the main clone",
        kind: "do",
      });
    } else {
      for (const t of targets) {
        const alias = aliasOf(t);
        const repo = repos.find((r) => r.alias === alias);
        out.push({
          text: `Work directly in ${alias}`,
          code: `${repo ? shortenHome(repo.path) : alias} · the directory your editor has open`,
          kind: "warn",
        });
      }
    }

    out.push({
      text: "Start the agent in tmux",
      code: agentCmd,
      kind: dangerouslySkipPermissions ? "warn" : "do",
    });

    if (taskPrompt.trim()) {
      out.push({
        text: "Send the task as the first message",
        code: `${taskPrompt.trim().length} characters, written to a file the agent is told to read`,
        kind: "do",
      });
    } else {
      out.push({
        text: "Send nothing — the agent waits idle at its prompt",
        code: "you type the task into the terminal yourself",
        kind: "warn",
      });
    }

    if (agentType === "cursor") {
      out.push({
        text: "No status hooks for Cursor",
        code: "its status is read off the terminal instead",
        kind: "warn",
      });
    } else if (!hookState) {
      out.push({
        text: "Install the status hooks if missing",
        code: "so the queue knows when a session needs you",
        kind: "do",
      });
    } else if (hookState.ok) {
      out.push({
        text: "Status hooks are already installed",
        code: hookState.installed.join(", "),
        kind: "do",
      });
    } else {
      out.push({
        text: `Install ${hookState.missing.length} missing status hook${hookState.missing.length === 1 ? "" : "s"}`,
        code: hookState.missing.join(", "),
        kind: "warn",
      });
    }

    return out;
  }, [targets, source, isolated, repos, basePath, agentCmd, dangerouslySkipPermissions, taskPrompt, agentType, hookState]);

  const repoNote =
    targets.length === 0
      ? source === "chat"
        ? "No repo needed. Just talk starts an agent with no worktree, in your base directory."
        : "Nothing selected. Pick one, or choose Just talk for a session with no repo."
      : targets.length === 1
        ? "One repo. The agent sees only this tree."
        : `${targets.length} repos in one session. Useful when a change spans a backend and an SDK; noisier otherwise.`;

  const footNote: { text: string; icon: IconName; warn: boolean } =
    targets.length === 0
      ? source === "chat"
        ? {
            text: `No repo, so no worktree either. The agent starts in ${shortenHome(basePath || "~/projects")} and reads nothing until you point it at something.`,
            icon: "layers",
            warn: false,
          }
        : {
            text: "Nothing to prepare yet. The worktree question only applies once a repo is selected.",
            icon: "layers",
            warn: false,
          }
      : isolated
        ? {
            text: "Each worktree is a second checkout of the tracked tree. Your .env files are copied in and node_modules is symlinked from the main clone, so there is no dependency install. The wt-<id> branch suffix is generated when you press launch.",
            icon: "layers",
            warn: false,
          }
        : {
            text: "No worktree. The agent shares the directory your editor has open.",
            icon: "alert",
            warn: true,
          };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      // A ticket typed but never attached used to be dropped in silence: no
      // brief, no worktree, an agent booted into a bare shell. Fold it in here
      // rather than depend on having pressed "Add to the brief".
      let prompt = taskPrompt.trim();
      const pendingId = source === "ticket" && !ticketId ? parseTicketId(ticketDraft) : null;
      if (pendingId) {
        const line = ticketLine(pendingId);
        prompt = prompt ? `${line}\n\n${prompt}` : `${line}\n\nConstraint:\nDone when:`;
      }

      const result = await createSession({
        targets,
        name: sessionName.trim() || undefined,
        prompt: prompt || undefined,
        grouped,
        isolated,
        dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
        agentType,
        meta: Object.keys(metaValues).length > 0 ? metaValues : undefined,
      });
      if (targets.length > 0) {
        const updated = saveRecentRepos(targets, recentRepos);
        setRecentRepos(updated);
        updatePreferences({ recentRepos: updated });
      }
      // Navigate to dashboard with first created session selected
      const firstSession = result.sessions[0];
      navigate(`/?session=${encodeURIComponent(firstSession)}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLoadTemplate = async (t: SessionTemplate) => {
    setSubmitting(true);
    setError("");
    try {
      const result = await createSession({
        targets: t.targets,
        grouped,
        isolated: t.isolated || false,
        dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
        agentType,
      });
      if (t.targets.length > 0) {
        const updated = saveRecentRepos(t.targets, recentRepos);
        setRecentRepos(updated);
        updatePreferences({ recentRepos: updated });
      }
      const firstSession = result.sessions[0];
      navigate(`/?session=${encodeURIComponent(firstSession)}`);
    } catch (err: any) {
      // Fallback: load template into form so user can adjust
      setTargets(t.targets);
      setIsolated(t.isolated || false);
      if (t.meta) setMetaValues(t.meta);
      setSessionName("");
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveTemplate = async () => {
    const name = templateName.trim();
    if (!name) return;
    setSavingTemplate(true);
    const t = await saveTemplate({
      name,
      targets,
      isolated,
      grouped,
      meta: Object.keys(metaValues).length > 0 ? metaValues : undefined,
    });
    setTemplates((prev) => [...prev, t]);
    setSavingTemplate(false);
    setTemplateName("");
    setNamingTemplate(false);
  };

  const handleDeleteTemplate = async (id: string) => {
    await deleteTemplate(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <form className="cs-shell" onSubmit={handleSubmit}>
      <div className="cs-bar">
        <button
          type="button"
          className="cs-icon-btn"
          onClick={() => navigate("/")}
          aria-label="Close and go back to the session list"
          title="Close"
        >
          <Icon name="close" size={16} />
        </button>
        <span className="cs-bar-title">New session</span>
      </div>

      <div className="cs-body">
        <div className="cs-main">
          <div className="cs-main-inner">
            {templates.length > 0 && (
              <fieldset className="cs-fieldset">
                <legend className="cs-legend">Start from a template</legend>
                <div className="cs-templates">
                  {templates.map((t) => (
                    <div key={t.id} className="cs-template">
                      <button
                        type="button"
                        className="cs-template-load"
                        onClick={() => handleLoadTemplate(t)}
                        disabled={submitting}
                      >
                        {t.name}
                        <span className="cs-template-repos">
                          {t.targets.length > 0 ? t.targets.join(", ") : "no repos"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="cs-template-del"
                        onClick={() => handleDeleteTemplate(t.id)}
                        aria-label={`Delete the ${t.name} template`}
                        title="Delete template"
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </fieldset>
            )}

            <fieldset className="cs-fieldset">
              <legend className="cs-legend">Where the task comes from</legend>
              <div className="cs-chips" role="group" aria-label="Where the task comes from">
                {SOURCES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="cs-chip"
                    aria-pressed={source === s.id}
                    onClick={() => {
                      setSource(s.id);
                      if (s.id === "slack") setSlackOpen(true);
                    }}
                  >
                    <Icon name={s.icon} size={14} />
                    {s.label}
                  </button>
                ))}
              </div>

              {source === "ticket" && !ticketId && (
                <div className="cs-row" style={{ marginTop: 14 }}>
                  <div className="cs-field">
                    <label className="cs-label" htmlFor="cs-ticket">
                      Linear ticket id
                    </label>
                    <input
                      id="cs-ticket"
                      type="text"
                      className="cs-input cs-input-mono"
                      placeholder="MOD-412"
                      value={ticketDraft}
                      onChange={(e) => { setTicketDraft(e.target.value); setTicketError(""); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          attachTicket();
                        }
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="cs-btn"
                    onClick={attachTicket}
                    disabled={!ticketDraft.trim()}
                  >
                    Add to the brief
                  </button>
                </div>
              )}

              {source === "ticket" && !ticketId && ticketDraft.trim() && (
                <p className={`cs-ticket-note${ticketError ? " cs-ticket-note-bad" : ""}`}>
                  {ticketError
                    ? ticketError
                    : `Reads as ${parseTicketId(ticketDraft)} — added to the brief when you launch.`}
                </p>
              )}

              {source === "ticket" && ticketId && (
                <div className="cs-card">
                  <span className="cs-card-mark">
                    <Icon name="repo" size={16} />
                  </span>
                  <div className="cs-card-body">
                    <div className="cs-card-title">{ticketId}</div>
                    <div className="cs-note">
                      {linearMcp === true
                        ? "AgentDock has no Linear connection of its own, so it fetched no title or comments. The id is in your brief and the agent reads the ticket itself with the Linear MCP server you have configured."
                        : linearMcp === false
                          ? "AgentDock has no Linear connection, and no Linear MCP server is configured for the agent either. The id is in your brief as a reference only — paste anything the agent needs to know."
                          : "AgentDock has no Linear connection of its own, so nothing was fetched. The id goes into your brief as written."}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cs-link cs-link-quiet cs-card-dismiss"
                    onClick={dismissTicket}
                    aria-label={`Remove ticket ${ticketId}`}
                    title="Remove ticket"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              )}

              {source === "chat" && (
                <div className="cs-note" style={{ marginTop: 14 }}>
                  No repo and no worktree. The agent starts in your base directory — useful for thinking
                  through an approach before you spend a worktree on it.
                </div>
              )}
            </fieldset>

            <fieldset className="cs-fieldset">
              <legend className="cs-legend">What it should do</legend>
              <div className="cs-composer">
                <label className="cs-sr" htmlFor="cs-prompt">
                  The task
                </label>
                <textarea
                  id="cs-prompt"
                  className="cs-composer-input"
                  placeholder={
                    "Set the default column order for the moderation content queue to newest-first.\nDo not touch the row-selection code.\nDone when the existing queue tests pass."
                  }
                  value={taskPrompt}
                  onChange={(e) => setTaskPrompt(e.target.value)}
                  rows={5}
                />
                <div className="cs-composer-foot">
                  <span className="cs-mono">
                    {taskPrompt.length === 0 ? "empty" : `${taskPrompt.length} characters`}
                  </span>
                  <input
                    ref={fileInputRef}
                    id="cs-file"
                    type="file"
                    aria-label="Attach a file"
                    className="cs-sr"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleAttachFile(f);
                    }}
                  />
                  <button
                    type="button"
                    className="cs-link cs-foot-spacer"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? "Uploading…" : "Attach a file"}
                  </button>
                  <span className="cs-foot-sep" aria-hidden="true">
                    ·
                  </span>
                  <button
                    type="button"
                    className="cs-link"
                    onClick={() => setSlackOpen((v) => !v)}
                    aria-expanded={slackOpen}
                  >
                    Paste a Slack thread
                  </button>
                </div>
              </div>

              {slackOpen && (
                <div className="cs-paste">
                  <div className="cs-field">
                    <label className="cs-label" htmlFor="cs-slack">
                      Slack thread
                    </label>
                    <textarea
                      id="cs-slack"
                      className="cs-textarea"
                      rows={4}
                      placeholder="Copy the messages out of Slack and paste them here."
                      value={slackDraft}
                      onChange={(e) => setSlackDraft(e.target.value)}
                    />
                  </div>
                  <div className="cs-paste-actions">
                    <button
                      type="button"
                      className="cs-btn"
                      onClick={appendSlack}
                      disabled={!slackDraft.trim()}
                    >
                      Append to the brief
                    </button>
                    <span className="cs-note">
                      There is no Slack integration — this only appends the text you paste.
                    </span>
                  </div>
                </div>
              )}

              <div className="cs-note-inline" style={{ marginTop: 10, marginBottom: 0 }}>
                <span className="cs-note-mark">
                  <Icon name="alert" size={14} />
                </span>
                <span className="cs-note">
                  A bounded task is the cheapest lever you have. An agent given “fix the queue” will
                  change nine files; one given a file, a constraint and a definition of done will change
                  three. Leave this empty to start the agent idle at its prompt.
                </span>
              </div>
            </fieldset>

            <fieldset className="cs-fieldset">
              <legend className="cs-legend">Repos</legend>
              <RepoSelector
                selected={targets}
                onChange={setTargets}
                recentRepos={recentRepos}
                primaryRepo={primaryRepo}
                onSetPrimary={(alias) => {
                  setPrimaryRepo(alias);
                  updatePreferences({ primaryRepo: alias });
                }}
              />
              <div className="cs-note" style={{ marginTop: 8 }}>
                {repoNote}
              </div>
            </fieldset>

            <fieldset className="cs-fieldset">
              <legend className="cs-legend">How it runs</legend>
              <div className="cs-options">
                <label className={`cs-option ${isolated ? "cs-option-on" : ""}`}>
                  <span className="cs-option-head">
                    <input
                      type="checkbox"
                      className="cs-check-input"
                      checked={isolated}
                      onChange={(e) => setIsolated(e.target.checked)}
                    />
                    <span className="cs-check-box" aria-hidden="true">
                      <Icon name="check" size={12} />
                    </span>
                    <span className="cs-option-title">Isolated worktree</span>
                  </span>
                  <span className="cs-option-detail">
                    Its own directory and branch, so it cannot collide with your editor or another
                    agent. Costs a second checkout of the tree.
                  </span>
                </label>

                <label
                  className={`cs-option cs-option-warn ${dangerouslySkipPermissions ? "cs-option-on" : ""}`}
                >
                  <span className="cs-option-head">
                    <input
                      type="checkbox"
                      className="cs-check-input"
                      checked={dangerouslySkipPermissions}
                      onChange={(e) => setDangerouslySkipPermissions(e.target.checked)}
                    />
                    <span className="cs-check-box" aria-hidden="true">
                      <Icon name="check" size={12} />
                    </span>
                    <span className="cs-option-title">Skip permission prompts</span>
                  </span>
                  <span className="cs-option-detail">
                    {dangerouslySkipPermissions
                      ? "It will edit and run commands without asking. Only sensible inside a worktree you are willing to throw away."
                      : "It will ask before each edit and each command, and runs with an allow-list of tools."}
                  </span>
                </label>
              </div>

              <div className="cs-field">
                <span className="cs-label" id="cs-agent-label">
                  Agent
                </span>
                <div className="cs-radios" role="radiogroup" aria-labelledby="cs-agent-label">
                  <label className={`cs-radio ${agentType === "claude" ? "cs-radio-on" : ""}`}>
                    <input
                      type="radio"
                      name="agentType"
                      value="claude"
                      checked={agentType === "claude"}
                      onChange={(e) => setAgentType(e.target.value as AgentType)}
                    />
                    <span>Claude Code</span>
                  </label>
                  <label className={`cs-radio ${agentType === "cursor" ? "cs-radio-on" : ""}`}>
                    <input
                      type="radio"
                      name="agentType"
                      value="cursor"
                      checked={agentType === "cursor"}
                      onChange={(e) => setAgentType(e.target.value as AgentType)}
                    />
                    <span>Cursor Agent</span>
                  </label>
                </div>
              </div>
            </fieldset>

            <fieldset className="cs-fieldset">
              <legend className="cs-legend">Name and properties</legend>
              <div className="cs-field" style={{ marginBottom: 12 }}>
                <label className="cs-label" htmlFor="cs-name">
                  Session name — optional, one is generated if you leave it empty
                </label>
                <input
                  id="cs-name"
                  type="text"
                  className="cs-input"
                  placeholder="e.g. rename-provider, fix-auth"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                />
              </div>

              {metaPresets.length > 0 && (
                <div className="cs-meta">
                  {metaPresets.map((preset) => (
                    <div key={preset.key} className="cs-field">
                      {preset.values.length > 0 ? (
                        <span className="cs-label">{preset.label}</span>
                      ) : (
                        <label className="cs-label" htmlFor={`cs-meta-${preset.key}`}>
                          {preset.label}
                        </label>
                      )}
                      {preset.values.length > 0 ? (
                        <MetaSelect
                          values={preset.values}
                          value={metaValues[preset.key] || ""}
                          onChange={(v) => setMetaValues((prev) => ({ ...prev, [preset.key]: v }))}
                          onAddNew={(v) => {
                            preset.values.push(v);
                            setMetaValues((prev) => ({ ...prev, [preset.key]: v }));
                            setMetaPresets((prev) => [...prev]);
                            saveMetaPropertyPresets(metaPresets);
                          }}
                          placeholder="—"
                        />
                      ) : (
                        <input
                          id={`cs-meta-${preset.key}`}
                          type="text"
                          className="cs-input"
                          placeholder={preset.label}
                          value={metaValues[preset.key] || ""}
                          onChange={(e) =>
                            setMetaValues((prev) => ({ ...prev, [preset.key]: e.target.value }))
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </fieldset>

            {error && (
              <div className="cs-error" role="alert">
                {error}
              </div>
            )}
          </div>
        </div>

        <aside className="cs-aside" aria-label="What launching will do">
          <div className="cs-aside-head">
            <span className="cs-eyebrow">Before it starts</span>
            <div className="cs-note">
              Exactly what happens when you press launch. No surprises after the fact.
            </div>
          </div>

          <ol className="cs-steps">
            {steps.map((s, i) => (
              <li
                key={`${s.text}-${i}`}
                className={`cs-step ${s.kind === "warn" ? "cs-step-warn" : s.kind === "blocked" ? "cs-step-blocked" : ""}`}
              >
                <span className="cs-step-rail" aria-hidden="true">
                  <span className="cs-step-node" />
                  {i < steps.length - 1 && <span className="cs-step-line" />}
                </span>
                <span className="cs-step-body">
                  <span className="cs-step-text">{s.text}</span>
                  {s.code && <div className="cs-step-code" title={s.code}>{s.code}</div>}
                </span>
              </li>
            ))}
          </ol>

          {namingTemplate && (
            <div className="cs-aside-panel">
              <span className="cs-eyebrow">Save as a template</span>
              <div className="cs-row">
                <div className="cs-field">
                  <label className="cs-sr" htmlFor="cs-template-name">
                    Template name
                  </label>
                  <input
                    id="cs-template-name"
                    type="text"
                    className="cs-input"
                    placeholder="Name this template…"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSaveTemplate();
                      }
                      if (e.key === "Escape") {
                        setNamingTemplate(false);
                        setTemplateName("");
                      }
                    }}
                    autoFocus
                  />
                </div>
                <button
                  type="button"
                  className="cs-btn"
                  onClick={handleSaveTemplate}
                  disabled={savingTemplate || !templateName.trim()}
                >
                  {savingTemplate ? "Saving…" : "Save"}
                </button>
              </div>
              <div className="cs-note">
                Saves the repos, the worktree choice and the properties — not the brief.
              </div>
            </div>
          )}

          <div className={`cs-aside-foot ${footNote.warn ? "cs-aside-foot-warn" : ""}`}>
            <span className="cs-aside-foot-mark">
              <Icon name={footNote.icon} size={14} />
            </span>
            <span className="cs-aside-foot-text">{footNote.text}</span>
          </div>
        </aside>
      </div>

      {/* The action belongs where the form ends. It used to sit in the top bar,
          which scrolls out of reach on a form 439px taller than the viewport —
          you finished filling it in with nothing to press. */}
      <div className="cs-footer">
        <span className="cs-footer-hint">
          {ready
            ? `${targets.length > 0 ? `${targets.length} repo${targets.length === 1 ? "" : "s"}` : "Chat only"}${isolated ? " · isolated worktrees" : ""}`
            : "Pick a repo, or choose Just talk"}
        </span>
        <button
          type="button"
          className="cs-btn"
          onClick={() => setNamingTemplate((v) => !v)}
          aria-expanded={namingTemplate}
        >
          <Icon name="layers" size={14} />
          {namingTemplate ? "Cancel template" : "Save as template"}
        </button>
        <button
          type="submit"
          className="cs-btn cs-btn-primary cs-btn-launch"
          disabled={submitting || !ready}
          title={ready ? undefined : "Pick a repo, or choose Just talk"}
        >
          <Icon name="sparkle" size={15} />
          {submitting ? "Launching…" : "Launch"}
        </button>
      </div>
    </form>
  );
}
