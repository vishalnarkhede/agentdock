import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  createSession,
  fetchTemplates,
  saveTemplate,
  deleteTemplate,
  type SessionTemplate,
} from "../api";
import { RepoSelector, saveRecentRepos } from "../components/RepoSelector";
import type { AgentType } from "../types";

export function CreateSession() {
  const navigate = useNavigate();
  const [sessionName, setSessionName] = useState("");
  const [targets, setTargets] = useState<string[]>([]);
  const grouped = true;
  const [isolated, setIsolated] = useState(false);
  const [dangerouslySkipPermissions, setDangerouslySkipPermissions] = useState(false);
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);

  useEffect(() => {
    fetchTemplates().then(setTemplates);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = await createSession({
        targets,
        name: sessionName.trim() || undefined,
        grouped,
        isolated,
        dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
        agentType,
      });
      if (targets.length > 0) saveRecentRepos(targets);
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
      if (t.targets.length > 0) saveRecentRepos(t.targets);
      const firstSession = result.sessions[0];
      navigate(`/?session=${encodeURIComponent(firstSession)}`);
    } catch (err: any) {
      // Fallback: load template into form so user can adjust
      setTargets(t.targets);
      setIsolated(t.isolated || false);
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
    const t = await saveTemplate({
      name,
      targets,
      isolated,
      grouped,
    });
    setTemplates((prev) => [...prev, t]);
    setSavingTemplate(false);
  };

  const handleDeleteTemplate = async (id: string) => {
    await deleteTemplate(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="page">
      {templates.length > 0 && (
        <div className="templates-section">
          <div className="form-label">Templates</div>
          <div className="templates-list">
            {templates.map((t) => (
              <div key={t.id} className="template-item">
                <button
                  className="template-btn"
                  onClick={() => handleLoadTemplate(t)}
                >
                  {t.name}
                  <span className="template-repos">
                    {t.targets.length > 0 ? t.targets.join(", ") : "no repos"}
                  </span>
                </button>
                <button
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

      <form onSubmit={handleSubmit} className="create-form">
        <div className="form-row">
          <label className="form-label">Session Name (optional)</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g. rename-provider, fix-auth"
            value={sessionName}
            onChange={(e) => setSessionName(e.target.value)}
          />
        </div>

        <RepoSelector selected={targets} onChange={setTargets} />

        <div className="form-row">
          <label className="form-label">Agent Type</label>
          <div className="agent-type-selector">
            <label className="radio-label">
              <input
                type="radio"
                name="agentType"
                value="claude"
                checked={agentType === "claude"}
                onChange={(e) => setAgentType(e.target.value as AgentType)}
              />
              <span>Claude Code</span>
            </label>
            <label className="radio-label">
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

        <div className="form-row">
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={isolated}
              onChange={(e) => setIsolated(e.target.checked)}
            />
            <span>Isolated worktrees</span>
            <span className="toggle-hint">git worktree add per repo</span>
          </label>
        </div>

        <div className="form-row">
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={dangerouslySkipPermissions}
              onChange={(e) => setDangerouslySkipPermissions(e.target.checked)}
            />
            <span>Skip permissions</span>
            <span className="toggle-hint">--dangerously-skip-permissions</span>
          </label>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary btn-large" disabled={submitting}>
            {submitting ? "creating..." : "./launch"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleSaveTemplate}
            disabled={savingTemplate}
          >
            save as template
          </button>
        </div>
      </form>
    </div>
  );
}
