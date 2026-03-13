import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useSettings, type Settings } from "../hooks/useSettings";
import { useAuth } from "../hooks/useAuth";
import {
  fetchSettingsHealth,
  fetchSettingsRepos,
  fetchBasePath,
  updateBasePath,
  addSettingsRepo,
  deleteSettingsRepo,
  setPassword as apiSetPassword,
  fetchMcpServers,
  addMcpServerApi,
  deleteMcpServer,
  type SettingsHealth,
  type McpServerInfo,
} from "../api";
import type { RepoConfig } from "../types";

type Category =
  | "appearance"
  | "terminal"
  | "notifications"
  | "repos"
  | "mcp"
  | "security"
  | "health";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "notifications", label: "Notifications" },
  { id: "repos", label: "Repositories" },
  { id: "mcp", label: "MCP Servers" },
  { id: "security", label: "Security" },
  { id: "health", label: "Health" },
];

const THEMES: { id: Settings["theme"]; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "dark", label: "Dark" },
  { id: "midnight", label: "Midnight" },
  { id: "light", label: "Light" },
  { id: "minimal", label: "Minimal" },
  { id: "glass", label: "Glass" },
  { id: "notion", label: "Notion" },
  { id: "macos", label: "macOS" },
  { id: "win98", label: "Windows 98" },
];

const FONT_SIZES: { id: Settings["fontSize"]; label: string }[] = [
  { id: "small", label: "S" },
  { id: "medium", label: "M" },
  { id: "large", label: "L" },
];

const SCROLLBACK_OPTIONS = [1000, 5000, 10000, 50000];
const TERM_FONT_SIZES = [12, 13, 14, 15, 16];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const [category, setCategory] = useState<Category>("appearance");
  const { settings, updateSetting } = useSettings();
  const [notifStatus, setNotifStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleTestNotification = async () => {
    setNotifStatus(null);
    if (!("Notification" in window)) {
      setNotifStatus("Browser does not support notifications");
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") {
      perm = await Notification.requestPermission();
    }
    if (perm === "granted") {
      new Notification("AgentDock", {
        body: "Notifications are working!",
        tag: "settings-test",
      });
      setNotifStatus("Sent! Check your OS notification center");
    } else {
      setNotifStatus("Blocked — allow notifications in browser & macOS settings");
    }
  };

  return createPortal(
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close-btn" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-sidebar">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                className={`settings-sidebar-btn ${category === cat.id ? "settings-sidebar-btn-active" : ""}`}
                onClick={() => setCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <div className="settings-panel">
            {category === "appearance" && (
              <>
                <div className="settings-row">
                  <label className="settings-label">Theme</label>
                  <select
                    className="settings-select"
                    value={settings.theme}
                    onChange={(e) => updateSetting("theme", e.target.value as Settings["theme"])}
                  >
                    {THEMES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-row">
                  <label className="settings-label">Font Size</label>
                  <div className="settings-segmented">
                    {FONT_SIZES.map((f) => (
                      <button
                        key={f.id}
                        className={`settings-segmented-btn ${settings.fontSize === f.id ? "settings-segmented-btn-active" : ""}`}
                        onClick={() => updateSetting("fontSize", f.id)}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
            {category === "terminal" && (
              <>
                <div className="settings-row">
                  <label className="settings-label">Cursor Blink</label>
                  <button
                    className={`settings-toggle ${settings.cursorBlink ? "settings-toggle-on" : ""}`}
                    onClick={() => updateSetting("cursorBlink", !settings.cursorBlink)}
                    role="switch"
                    aria-checked={settings.cursorBlink}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-row">
                  <label className="settings-label">Scrollback</label>
                  <select
                    className="settings-select"
                    value={settings.scrollback}
                    onChange={(e) => updateSetting("scrollback", Number(e.target.value))}
                  >
                    {SCROLLBACK_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n.toLocaleString()} lines
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-row">
                  <label className="settings-label">Terminal Font Size</label>
                  <select
                    className="settings-select"
                    value={settings.terminalFontSize}
                    onChange={(e) => updateSetting("terminalFontSize", Number(e.target.value))}
                  >
                    {TERM_FONT_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n}px
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            {category === "notifications" && (
              <>
                <div className="settings-row">
                  <label className="settings-label">Enable Notifications</label>
                  <button
                    className={`settings-toggle ${settings.notificationsEnabled ? "settings-toggle-on" : ""}`}
                    onClick={() => updateSetting("notificationsEnabled", !settings.notificationsEnabled)}
                    role="switch"
                    aria-checked={settings.notificationsEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-row">
                  <label className="settings-label">Test</label>
                  <button
                    className="settings-test-btn"
                    onClick={handleTestNotification}
                    disabled={!settings.notificationsEnabled}
                  >
                    Send test notification
                  </button>
                </div>
                {notifStatus && (
                  <div className="settings-row">
                    <span className="settings-notif-status">{notifStatus}</span>
                  </div>
                )}
              </>
            )}
            {category === "repos" && <ReposPanel />}
            {category === "mcp" && <McpServersPanel />}
            {category === "security" && <SecurityPanel />}
            {category === "health" && <HealthPanel />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Health Panel ───

function HealthPanel() {
  const [health, setHealth] = useState<SettingsHealth | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSettingsHealth()
      .then(setHealth)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="settings-loading">Checking tools...</div>;
  if (!health) return <div className="settings-error">Failed to check health</div>;

  const tools = [
    { name: "tmux", ...health.tmux, required: true },
    { name: "claude", ...health.claude, required: true },
    { name: "cursor (agent CLI)", ...health.cursor, required: false },
    { name: "git", ...health.git, required: true },
    { name: "gh (GitHub CLI)", ...health.gh, required: false },
    { name: "bun", ...health.bun, required: true },
    { name: "psql", ...health.psql, required: false },
  ];

  return (
    <>
      <div className="settings-health-list">
        {tools.map((tool) => (
          <div key={tool.name} className="settings-health-row">
            <span className={`settings-health-dot ${tool.installed ? "green" : "red"}`} />
            <span className="settings-health-name">{tool.name}</span>
            {tool.installed ? (
              <span className="settings-health-version">{tool.version}</span>
            ) : (
              <span className="settings-health-missing">
                {tool.required ? "missing (required)" : "missing (optional)"}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Repos Panel ───

function ReposPanel() {
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [basePath, setBasePath] = useState("");
  const [editingBase, setEditingBase] = useState(false);
  const [baseInput, setBaseInput] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newRemote, setNewRemote] = useState("");

  const load = useCallback(() => {
    fetchSettingsRepos().then(setRepos);
    fetchBasePath().then((p) => {
      setBasePath(p);
      setBaseInput(p);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSaveBase = async () => {
    await updateBasePath(baseInput);
    setBasePath(baseInput);
    setEditingBase(false);
  };

  const handleAddRepo = async () => {
    if (!newAlias || !newPath) return;
    await addSettingsRepo({ alias: newAlias, path: newPath, remote: newRemote || undefined });
    setNewAlias("");
    setNewPath("");
    setNewRemote("");
    setShowAdd(false);
    load();
  };

  const handleDelete = async (alias: string) => {
    await deleteSettingsRepo(alias);
    load();
  };

  return (
    <>
      <div className="settings-row">
        <label className="settings-label">Base Path</label>
        {editingBase ? (
          <div className="settings-inline-form">
            <input
              className="form-input"
              value={baseInput}
              onChange={(e) => setBaseInput(e.target.value)}
              placeholder="/Users/you/projects"
            />
            <button className="btn btn-primary" onClick={handleSaveBase}>Save</button>
            <button className="btn" onClick={() => { setEditingBase(false); setBaseInput(basePath); }}>Cancel</button>
          </div>
        ) : (
          <div className="settings-inline-form">
            <code className="settings-path-display">{basePath}</code>
            <button className="btn" onClick={() => setEditingBase(true)}>Edit</button>
          </div>
        )}
      </div>

      <div className="settings-row">
        <label className="settings-label">Repos</label>
        <button className="btn btn-primary settings-add-btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add"}
        </button>
      </div>

      {showAdd && (
        <div className="settings-add-form">
          <input
            className="form-input"
            value={newAlias}
            onChange={(e) => setNewAlias(e.target.value)}
            placeholder="Alias (e.g. my-app)"
          />
          <input
            className="form-input"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="Path (e.g. /Users/you/projects/my-app)"
          />
          <input
            className="form-input"
            value={newRemote}
            onChange={(e) => setNewRemote(e.target.value)}
            placeholder="Remote URL (optional)"
          />
          <button className="btn btn-primary" onClick={handleAddRepo} disabled={!newAlias || !newPath}>
            Add Repository
          </button>
        </div>
      )}

      <div className="settings-repo-list">
        {repos.length === 0 && (
          <div className="settings-empty">No repositories configured.</div>
        )}
        {repos.map((repo) => (
          <div key={repo.alias} className="settings-repo-row">
            <div className="settings-repo-info">
              <span className="settings-repo-alias">{repo.alias}</span>
              <span className="settings-repo-path">{repo.path}</span>
              {repo.remote && <span className="settings-repo-remote">{repo.remote}</span>}
            </div>
            <button className="btn btn-danger-sm" onClick={() => handleDelete(repo.alias)}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── MCP Servers Panel ───

function McpServersPanel() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envPairs, setEnvPairs] = useState<{ key: string; value: string }[]>([]);

  const load = useCallback(() => {
    fetchMcpServers().then(setServers);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!name || !command) return;
    const parsedArgs = args.trim()
      ? args.split(/[\s,]+/).map(a => a.replace(/^["']|["']$/g, "")).filter(Boolean)
      : [];
    const env: Record<string, string> = {};
    for (const pair of envPairs) {
      if (pair.key.trim()) env[pair.key.trim()] = pair.value;
    }
    await addMcpServerApi({
      name,
      command,
      args: parsedArgs,
      env: Object.keys(env).length > 0 ? env : undefined,
    });
    setName(""); setCommand(""); setArgs(""); setEnvPairs([]);
    setShowAdd(false);
    load();
  };

  const handleDelete = async (serverName: string) => {
    await deleteMcpServer(serverName);
    load();
  };

  const addEnvPair = () => setEnvPairs([...envPairs, { key: "", value: "" }]);
  const updateEnvPair = (i: number, field: "key" | "value", val: string) => {
    const updated = [...envPairs];
    updated[i][field] = val;
    setEnvPairs(updated);
  };
  const removeEnvPair = (i: number) => setEnvPairs(envPairs.filter((_, idx) => idx !== i));

  return (
    <>
      <p className="settings-security-desc">
        MCP servers are synced to all agent configs (Claude, Cursor) so every session has access.
      </p>
      <div className="settings-row">
        <label className="settings-label">Servers</label>
        <button className="btn btn-primary settings-add-btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add"}
        </button>
      </div>

      {showAdd && (
        <div className="settings-add-form">
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. linear)" />
          <input className="form-input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Command (e.g. npx)" />
          <input className="form-input" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="Args (space-separated, e.g. -y @mseep/linear-mcp)" />
          <div style={{ marginTop: 4 }}>
            <label className="settings-label" style={{ fontSize: 12 }}>Environment Variables</label>
            {envPairs.map((pair, i) => (
              <div key={i} className="settings-db-row" style={{ marginBottom: 4 }}>
                <input className="form-input" value={pair.key} onChange={(e) => updateEnvPair(i, "key", e.target.value)} placeholder="KEY" style={{ flex: 1 }} />
                <input className="form-input" value={pair.value} onChange={(e) => updateEnvPair(i, "value", e.target.value)} placeholder="value" style={{ flex: 2 }} />
                <button className="btn btn-danger-sm" onClick={() => removeEnvPair(i)}>x</button>
              </div>
            ))}
            <button className="btn btn-sm" onClick={addEnvPair} style={{ marginTop: 4 }}>+ Add env var</button>
          </div>
          <button className="btn btn-primary" onClick={handleAdd} disabled={!name || !command} style={{ marginTop: 8 }}>
            Add Server
          </button>
        </div>
      )}

      <div className="settings-repo-list">
        {servers.length === 0 && (
          <div className="settings-empty">No MCP servers configured.</div>
        )}
        {servers.map((server) => (
          <div key={server.name} className="settings-repo-row">
            <div className="settings-repo-info">
              <span className="settings-repo-alias">{server.name}</span>
              <span className="settings-repo-path">
                {server.command} {server.args.join(" ")}
              </span>
              {server.env && Object.keys(server.env).length > 0 && (
                <span className="settings-repo-remote">
                  env: {Object.keys(server.env).join(", ")}
                </span>
              )}
            </div>
            <button className="btn btn-danger-sm" onClick={() => handleDelete(server.name)}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Security Panel ───

function SecurityPanel() {
  const { enabled, logout, refresh } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSetPassword = async () => {
    setError(null);
    setSuccess(null);
    if (password.length < 4) {
      setError("Password must be at least 4 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setSaving(true);
    const result = await apiSetPassword(password);
    setSaving(false);
    if (result.error) {
      setError(result.error);
    } else {
      setPassword("");
      setConfirm("");
      setSuccess(enabled ? "Password updated" : "Password set — auth is now enabled");
      refresh();
    }
  };

  return (
    <>
      <p className="settings-security-desc">
        {enabled
          ? "Auth is enabled. You can change your password below."
          : "No password set. Set one to protect access from your network."}
      </p>
      <div className="settings-security-form">
        <input
          className="form-input"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(null); setSuccess(null); }}
          placeholder={enabled ? "New password" : "Choose a password"}
        />
        <input
          className="form-input"
          type="password"
          value={confirm}
          onChange={(e) => { setConfirm(e.target.value); setError(null); setSuccess(null); }}
          placeholder="Confirm password"
        />
        {error && <div className="settings-security-error">{error}</div>}
        {success && <div className="settings-security-success">{success}</div>}
        <button
          className="btn btn-primary"
          onClick={handleSetPassword}
          disabled={saving || !password || !confirm}
        >
          {saving ? "..." : enabled ? "Change Password" : "Set Password"}
        </button>
      </div>

      {enabled && (
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-danger-sm" onClick={logout}>
            Log out
          </button>
        </div>
      )}
    </>
  );
}
