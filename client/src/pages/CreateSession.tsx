import { useState, useEffect, useRef } from "react";
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
  type SessionTemplate,
} from "../api";
import { RepoSelector, saveRecentRepos } from "../components/RepoSelector";
import { MetaSelect } from "../components/MetaSelect";
import type { AgentType, MetaPropertyPreset, WorktreeMode } from "../types";

const EMPTY_META_VALUES: Record<string, string> = {};

type TargetMode = "checkout" | "general";

interface CreateSessionFormProps {
  surface?: "page" | "modal";
  initialMetaValues?: Record<string, string>;
  initialTargetMode?: TargetMode;
  initialSessionName?: string;
  initialTargets?: string[];
  initialAgentType?: AgentType;
  onCancel?: () => void;
  onCreated?: (sessionName: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

function CreateSessionForm({
  surface = "page",
  initialMetaValues = EMPTY_META_VALUES,
  initialTargetMode = "checkout",
  initialSessionName = "",
  initialTargets = [],
  initialAgentType = "claude",
  onCancel,
  onCreated,
  onBusyChange,
}: CreateSessionFormProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [sessionName, setSessionName] = useState(initialSessionName);
  const [targetMode, setTargetMode] = useState<TargetMode>(initialTargetMode);
  const [targets, setTargets] = useState<string[]>(initialTargets);
  const grouped = true;
  const [worktreeMode, setWorktreeMode] = useState<WorktreeMode>("direct");
  const [customWorktreeBase, setCustomWorktreeBase] = useState("");
  const isolated = worktreeMode !== "direct";
  const [dangerouslySkipPermissions, setDangerouslySkipPermissions] = useState(false);
  const [agentType, setAgentType] = useState<AgentType>(initialAgentType);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [metaPresets, setMetaPresets] = useState<MetaPropertyPreset[]>([]);
  const [metaValues, setMetaValues] = useState<Record<string, string>>({});
  const [recentRepos, setRecentRepos] = useState<string[]>([]);

  // Read once, on mount. As a modal this form lives inside Dashboard, which owns
  // the search params and rewrites ?session= whenever the selected agent changes;
  // with those in the dep array the effect refires and setMetaValues(initial)
  // throws away whatever the user has typed in the meantime.
  const prefillRef = useRef({ searchParams, initialMetaValues });

  useEffect(() => {
    const { searchParams: params, initialMetaValues: initialMeta } = prefillRef.current;
    fetchTemplates().then(setTemplates);
    fetchMetaPropertyPresets().then((presets) => {
      setMetaPresets(presets);
      // Pre-fill meta values from URL params (e.g., /create?priority=high)
      // or from a dashboard group that opened the modal.
      const initial: Record<string, string> = {};
      for (const p of presets) {
        const v = params.get(p.key);
        if (v) initial[p.key] = v;
        if (initialMeta[p.key]) initial[p.key] = initialMeta[p.key];
      }
      if (Object.keys(initial).length > 0) setMetaValues(initial);
    });
    fetchPreferences().then((p) => {
      if (p.recentRepos) setRecentRepos(p.recentRepos);
    });
  }, []);

  useEffect(() => {
    onBusyChange?.(submitting || savingTemplate);
  }, [submitting, savingTemplate, onBusyChange]);

  const handleTargetModeChange = (mode: TargetMode) => {
    setTargetMode(mode);
    if (mode === "general") {
      setTargets([]);
      setWorktreeMode("direct");
      setCustomWorktreeBase("");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const sessionTargets = targetMode === "checkout" ? targets : [];
    const sessionWorktreeMode = targetMode === "checkout" ? worktreeMode : "direct";
    const sessionIsolated = targetMode === "checkout" && sessionWorktreeMode !== "direct";
    if (sessionWorktreeMode === "fresh-custom" && !customWorktreeBase.trim()) {
      setError("Enter a base branch, tag, or commit for the fresh worktree.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await createSession({
        targets: sessionTargets,
        name: sessionName.trim() || (targetMode === "general" ? "general-chat" : undefined),
        grouped,
        isolated: sessionIsolated,
        worktreeMode: sessionWorktreeMode,
        worktreeBase: sessionWorktreeMode === "fresh-custom" ? customWorktreeBase.trim() : undefined,
        dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
        agentType,
        meta: Object.keys(metaValues).length > 0 ? metaValues : undefined,
      });
      if (sessionTargets.length > 0) {
        const updated = saveRecentRepos(sessionTargets, recentRepos);
        setRecentRepos(updated);
        updatePreferences({ recentRepos: updated });
      }
      // Navigate to dashboard with first created session selected
      const firstSession = result.sessions[0];
      if (firstSession) {
        if (onCreated) onCreated(firstSession);
        else navigate(`/?session=${encodeURIComponent(firstSession)}`);
      }
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
      const templateMode = t.targets.length > 0 ? (t.worktreeMode || (t.isolated ? "fresh-main" : "direct")) : "direct";
      const result = await createSession({
        targets: t.targets,
        grouped,
        isolated: t.targets.length > 0 && templateMode !== "direct",
        worktreeMode: templateMode,
        worktreeBase: t.targets.length > 0 ? t.worktreeBase : undefined,
        dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
        agentType,
      });
      if (t.targets.length > 0) {
        const updated = saveRecentRepos(t.targets, recentRepos);
        setRecentRepos(updated);
        updatePreferences({ recentRepos: updated });
      }
      const firstSession = result.sessions[0];
      if (firstSession) {
        if (onCreated) onCreated(firstSession);
        else navigate(`/?session=${encodeURIComponent(firstSession)}`);
      }
    } catch (err: any) {
      // Fallback: load template into form so user can adjust
      setTargetMode(t.targets.length > 0 ? "checkout" : "general");
      setTargets(t.targets);
      setWorktreeMode(t.targets.length > 0 ? (t.worktreeMode || (t.isolated ? "fresh-main" : "direct")) : "direct");
      setCustomWorktreeBase(t.targets.length > 0 ? (t.worktreeBase || "") : "");
      if (t.meta) setMetaValues(t.meta);
      setSessionName("");
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveTemplate = async () => {
    const name = prompt("Template name:");
    if (!name) return;
    setSavingTemplate(true);
    const templateTargets = targetMode === "checkout" ? targets : [];
    const templateWorktreeMode = targetMode === "checkout" ? worktreeMode : "direct";
    const t = await saveTemplate({
      name,
      targets: templateTargets,
      isolated: targetMode === "checkout" && isolated,
      worktreeMode: templateWorktreeMode,
      worktreeBase: templateWorktreeMode === "fresh-custom" ? customWorktreeBase.trim() : undefined,
      grouped,
      meta: Object.keys(metaValues).length > 0 ? metaValues : undefined,
    });
    setTemplates((prev) => [...prev, t]);
    setSavingTemplate(false);
  };

  const handleDeleteTemplate = async (id: string) => {
    await deleteTemplate(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <>
      {surface === "page" && templates.length > 0 && (
        <div className="templates-section">
          <div className="form-label">Templates</div>
          <div className="templates-list">
            {templates.map((t) => (
              <div key={t.id} className="template-item">
                <button
                  type="button"
                  className="template-btn"
                  onClick={() => handleLoadTemplate(t)}
                >
                  {t.name}
                  <span className="template-repos">
                    {t.targets.length > 0 ? t.targets.join(", ") : "no repos"}
                  </span>
                </button>
                <button
                  type="button"
                  className="template-delete"
                  onClick={() => handleDeleteTemplate(t.id)}
                  title="delete template"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className={`create-form${surface === "modal" ? " new-agent-form" : ""}`}>
        <div className={surface === "modal" ? "new-agent-form-fields" : "create-form-fields"}>
          <div className="form-row">
            <label className="form-label">Context</label>
            <div className="worktree-mode-selector target-mode-selector">
              <label className="worktree-mode-option">
                <input
                  type="radio"
                  name="targetMode"
                  checked={targetMode === "general"}
                  onChange={() => handleTargetModeChange("general")}
                />
                <span>
                  <strong>No checkout</strong>
                  <small>Chat without attaching a repo.</small>
                </span>
              </label>
              <label className="worktree-mode-option">
                <input
                  type="radio"
                  name="targetMode"
                  checked={targetMode === "checkout"}
                  onChange={() => handleTargetModeChange("checkout")}
                />
                <span>
                  <strong>Repo or worktree</strong>
                  <small>Select one or more targets.</small>
                </span>
              </label>
            </div>
          </div>

          {targetMode === "checkout" && (
            <RepoSelector
              selected={targets}
              onChange={setTargets}
              recentRepos={recentRepos}
              autoFocus={surface === "modal"}
            />
          )}

          <div className="new-agent-primary-grid">
            <div className="form-row">
              <label className="form-label">Agent</label>
              <div className="agent-type-selector">
                <label className="radio-label">
                  <input
                    type="radio"
                    name="agentType"
                    value="claude"
                    checked={agentType === "claude"}
                    onChange={(e) => setAgentType(e.target.value as AgentType)}
                  />
                  <span>Claude</span>
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="agentType"
                    value="codex"
                    checked={agentType === "codex"}
                    onChange={(e) => setAgentType(e.target.value as AgentType)}
                  />
                  <span>Codex</span>
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="agentType"
                    value="cursor"
                    checked={agentType === "cursor"}
                    onChange={(e) => setAgentType(e.target.value as AgentType)}
                  />
                  <span>Cursor</span>
                </label>
              </div>
            </div>
          </div>

          {targetMode === "checkout" && (
            <div className="form-row">
              <label className="form-label">Checkout</label>
              <div className="worktree-mode-selector">
                <label className="worktree-mode-option">
                  <input
                    type="radio"
                    name="worktreeMode"
                    checked={!isolated}
                    onChange={() => setWorktreeMode("direct")}
                  />
                  <span>
                    <strong>Selected checkout</strong>
                    <small>Use the selected repo or worktree.</small>
                  </span>
                </label>
                <label className="worktree-mode-option">
                  <input
                    type="radio"
                    name="worktreeMode"
                    checked={isolated}
                    onChange={() => setWorktreeMode("fresh-current")}
                  />
                  <span>
                    <strong>Temporary worktree</strong>
                    <small>Agent-owned isolated checkout on a wt-* branch.</small>
                  </span>
                </label>
              </div>
              {isolated && (
                <div className="worktree-base-row">
                  <label className="form-label form-label-inline" htmlFor="worktree-base">
                    Base
                  </label>
                  <select
                    id="worktree-base"
                    className="form-input worktree-base-select"
                    value={worktreeMode}
                    onChange={(e) => setWorktreeMode(e.target.value as WorktreeMode)}
                  >
                    <option value="fresh-current">Current branch</option>
                    <option value="fresh-main">main / master</option>
                    <option value="fresh-custom">Custom...</option>
                  </select>
                  {worktreeMode === "fresh-custom" && (
                    <input
                      className="form-input"
                      value={customWorktreeBase}
                      onChange={(e) => setCustomWorktreeBase(e.target.value)}
                      placeholder="Branch, tag, or commit"
                    />
                  )}
                </div>
              )}
            </div>
          )}

          <details className="new-agent-advanced">
            <summary>Advanced</summary>
            <div className="new-agent-advanced-body">
              <div className="form-row">
                <label className="form-label">Agent name (optional)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. rename-provider, fix-auth"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                />
              </div>

              {surface === "modal" && templates.length > 0 && (
                <div className="form-row new-agent-advanced-section">
                  <label className="form-label">Templates</label>
                  <div className="templates-list">
                    {templates.map((t) => (
                      <div key={t.id} className="template-item">
                        <button
                          type="button"
                          className="template-btn"
                          onClick={() => handleLoadTemplate(t)}
                        >
                          {t.name}
                          <span className="template-repos">
                            {t.targets.length > 0 ? t.targets.join(", ") : "no repos"}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="template-delete"
                          onClick={() => handleDeleteTemplate(t.id)}
                          title="delete template"
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {surface === "modal" && (
                <div className="new-agent-advanced-footer">
                  <button
                    type="button"
                    className="btn btn-sm new-agent-save-template-btn"
                    onClick={handleSaveTemplate}
                    disabled={savingTemplate || submitting}
                  >
                    Save Template
                  </button>
                </div>
              )}

              <div className="form-row">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={dangerouslySkipPermissions}
                    onChange={(e) => setDangerouslySkipPermissions(e.target.checked)}
                  />
                  <span>Skip permissions</span>
                  <span className="toggle-hint">launch without prompts</span>
                </label>
              </div>

              {metaPresets.length > 0 && (
                <div className="form-row">
                  <label className="form-label">Properties</label>
                  <div className="meta-fields">
                    {metaPresets.map((preset) => (
                      <div key={preset.key} className="meta-field">
                        <label className="meta-field-label">{preset.label}</label>
                        {preset.values.length > 0 ? (
                          <MetaSelect
                            values={preset.values}
                            value={metaValues[preset.key] || ""}
                            onChange={(v) => setMetaValues(prev => ({ ...prev, [preset.key]: v }))}
                            onAddNew={(v) => {
                              preset.values.push(v);
                              setMetaValues(prev => ({ ...prev, [preset.key]: v }));
                              setMetaPresets(prev => [...prev]);
                              saveMetaPropertyPresets(metaPresets);
                            }}
                            placeholder="-"
                          />
                        ) : (
                          <input
                            type="text"
                            className="form-input"
                            placeholder={preset.label}
                            value={metaValues[preset.key] || ""}
                            onChange={(e) => setMetaValues(prev => ({ ...prev, [preset.key]: e.target.value }))}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>
        </div>

        {error && <div className={`form-error${surface === "modal" ? " new-agent-error" : ""}`}>{error}</div>}

        <div className={surface === "modal" ? "worktrees-new-actions new-agent-actions" : "form-actions"}>
          {surface === "modal" && (
            <button type="button" className="btn btn-sm" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
          )}
          {surface === "page" && (
            <button
              type="button"
              className="btn btn-sm new-agent-save-template-btn"
              onClick={handleSaveTemplate}
              disabled={savingTemplate || submitting}
            >
              Save Template
            </button>
          )}
          <button type="submit" className="btn btn-primary btn-large" disabled={submitting}>
            {submitting ? "Launching..." : "Launch agent"}
          </button>
        </div>
      </form>
    </>
  );
}

export function CreateSessionModal({
  initialMetaValues = EMPTY_META_VALUES,
  initialTargetMode = "checkout",
  initialSessionName = "",
  initialTargets = [],
  initialAgentType = "claude",
  onClose,
  onCreated,
}: {
  initialMetaValues?: Record<string, string>;
  initialTargetMode?: TargetMode;
  initialSessionName?: string;
  initialTargets?: string[];
  initialAgentType?: AgentType;
  onClose: () => void;
  onCreated: (sessionName: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, onClose]);

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-modal new-agent-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-agent-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <span className="settings-title" id="new-agent-title">New agent</span>
          <button type="button" className="settings-close-btn" onClick={close} disabled={busy} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="new-agent-body">
          <CreateSessionForm
            surface="modal"
            initialMetaValues={initialMetaValues}
            initialTargetMode={initialTargetMode}
            initialSessionName={initialSessionName}
            initialTargets={initialTargets}
            initialAgentType={initialAgentType}
            onCancel={close}
            onCreated={onCreated}
            onBusyChange={setBusy}
          />
        </div>
      </div>
    </div>
  );
}

export function CreateSession() {
  return (
    <div className="page">
      <CreateSessionForm />
    </div>
  );
}
