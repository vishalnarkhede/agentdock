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
  fetchMetaPropertyPresets,
  saveMetaPropertyPresets,
  fetchNgrokBasicAuthStatus,
  setNgrokBasicAuth as apiSetNgrokBasicAuth,
  deleteNgrokBasicAuth as apiDeleteNgrokBasicAuth,
  type SettingsHealth,
  type McpServerInfo,
} from "../api";
import type { RepoConfig, MetaPropertyPreset } from "../types";

type Category =
  | "appearance"
  | "terminal"
  | "notifications"
  | "repos"
  | "meta"
  | "mcp"
  | "security"
  | "health"
  | "shortcuts";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "notifications", label: "Notifications" },
  { id: "repos", label: "Repositories" },
  { id: "meta", label: "Meta Properties" },
  { id: "mcp", label: "MCP Servers" },
  { id: "security", label: "Security" },
  { id: "health", label: "Health" },
  { id: "shortcuts", label: "Shortcuts" },
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

  // Tutorial: listen for tab-switch events
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail as Category;
      if (CATEGORIES.find((c) => c.id === tab)) setCategory(tab);
    };
    window.addEventListener("agentdock-settings-tab", handler);
    return () => window.removeEventListener("agentdock-settings-tab", handler);
  }, []);

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
      <div className="settings-modal" data-tutorial="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close-btn" data-tutorial="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-sidebar">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                data-tutorial={`settings-tab-${cat.id}`}
                className={`settings-sidebar-btn ${category === cat.id ? "settings-sidebar-btn-active" : ""}`}
                onClick={() => setCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <div className="settings-panel" data-tutorial="settings-panel">
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
            {category === "meta" && <MetaPropertiesPanel />}
            {category === "mcp" && <McpServersPanel />}
            {category === "security" && <SecurityPanel />}
            {category === "health" && <HealthPanel />}
            {category === "shortcuts" && <ShortcutsPanel />}
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

// ─── Meta Properties Panel ───

function MetaPropertiesPanel() {
  const [presets, setPresets] = useState<MetaPropertyPreset[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newValues, setNewValues] = useState("");

  const load = useCallback(() => {
    fetchMetaPropertyPresets().then(setPresets);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newKey || !newLabel) return;
    const values = newValues.trim()
      ? newValues.split(",").map(v => v.trim()).filter(Boolean)
      : [];
    const updated = [...presets, { key: newKey.trim().toLowerCase().replace(/\s+/g, "_"), label: newLabel.trim(), values }];
    await saveMetaPropertyPresets(updated);
    window.dispatchEvent(new CustomEvent("agentdock-meta-presets-changed"));
    setNewKey("");
    setNewLabel("");
    setNewValues("");
    setShowAdd(false);
    load();
  };

  const handleDelete = async (key: string) => {
    const updated = presets.filter(p => p.key !== key);
    await saveMetaPropertyPresets(updated);
    window.dispatchEvent(new CustomEvent("agentdock-meta-presets-changed"));
    load();
  };

  return (
    <>
      <p className="settings-security-desc">
        Define meta properties that can be assigned to sessions (e.g., customer, org ID, priority).
        Properties with preset values show as dropdowns; empty values allow free-text input.
      </p>
      <div className="settings-row">
        <label className="settings-label">Properties</label>
        <button className="btn btn-primary settings-add-btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Cancel" : "+ Add"}
        </button>
      </div>

      {showAdd && (
        <div className="settings-add-form">
          <input
            className="form-input"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="Key (e.g. customer)"
          />
          <input
            className="form-input"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. Customer)"
          />
          <input
            className="form-input"
            value={newValues}
            onChange={(e) => setNewValues(e.target.value)}
            placeholder="Preset values, comma-separated (leave empty for free-text)"
          />
          <button className="btn btn-primary" onClick={handleAdd} disabled={!newKey || !newLabel} style={{ marginTop: 8 }}>
            Add Property
          </button>
        </div>
      )}

      <div className="settings-repo-list">
        {presets.length === 0 && (
          <div className="settings-empty">No meta properties configured.</div>
        )}
        {presets.map((preset, idx) => (
          <MetaPropertyRow
            key={preset.key}
            preset={preset}
            onUpdate={async (updated) => {
              const next = [...presets];
              next[idx] = updated;
              await saveMetaPropertyPresets(next);
              window.dispatchEvent(new CustomEvent("agentdock-meta-presets-changed"));
              load();
            }}
            onDelete={() => handleDelete(preset.key)}
          />
        ))}
      </div>
    </>
  );
}

// ─── Meta Property Row (editable) ───

function MetaPropertyRow({ preset, onUpdate, onDelete }: {
  preset: MetaPropertyPreset;
  onUpdate: (updated: MetaPropertyPreset) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(preset.label);
  const [values, setValues] = useState(preset.values.join(", "));

  const handleSave = () => {
    const parsed = values.trim()
      ? values.split(",").map(v => v.trim()).filter(Boolean)
      : [];
    onUpdate({ ...preset, label: label.trim(), values: parsed });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="settings-repo-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="form-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label"
            style={{ flex: 1 }}
          />
          <span className="settings-repo-remote" style={{ alignSelf: "center", flexShrink: 0 }}>key: {preset.key}</span>
        </div>
        <input
          className="form-input"
          value={values}
          onChange={(e) => setValues(e.target.value)}
          placeholder="Preset values, comma-separated (leave empty for free-text)"
        />
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={!label.trim()}>Save</button>
          <button className="btn btn-sm" onClick={() => { setLabel(preset.label); setValues(preset.values.join(", ")); setEditing(false); }}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-repo-row">
      <div className="settings-repo-info">
        <span className="settings-repo-alias">{preset.label}</span>
        <span className="settings-repo-path">
          {preset.values.length > 0 ? preset.values.join(", ") : "(free text)"}
        </span>
        <span className="settings-repo-remote">key: {preset.key}</span>
      </div>
      <button className="btn btn-sm" onClick={() => setEditing(true)} style={{ marginRight: 4 }}>
        Edit
      </button>
      <button className="btn btn-danger-sm" onClick={onDelete}>
        Remove
      </button>
    </div>
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

  const [ngrokAuth, setNgrokAuth] = useState("");
  const [ngrokConfigured, setNgrokConfigured] = useState(false);
  const [ngrokError, setNgrokError] = useState<string | null>(null);
  const [ngrokSuccess, setNgrokSuccess] = useState<string | null>(null);
  const [ngrokSaving, setNgrokSaving] = useState(false);

  useEffect(() => {
    fetchNgrokBasicAuthStatus().then((s) => setNgrokConfigured(s.configured));
  }, []);

  const handleSaveNgrokAuth = async () => {
    setNgrokError(null);
    setNgrokSuccess(null);
    if (!ngrokAuth.includes(":")) {
      setNgrokError("Format must be user:password");
      return;
    }
    setNgrokSaving(true);
    const result = await apiSetNgrokBasicAuth(ngrokAuth);
    setNgrokSaving(false);
    if (result.error) {
      setNgrokError(result.error);
    } else {
      setNgrokAuth("");
      setNgrokConfigured(true);
      setNgrokSuccess("Saved — will be used next time ngrok starts");
    }
  };

  const handleClearNgrokAuth = async () => {
    await apiDeleteNgrokBasicAuth();
    setNgrokConfigured(false);
    setNgrokSuccess("Ngrok basic auth removed");
  };

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

      <div className="settings-section-divider" />
      <p className="settings-label" style={{ marginBottom: 6 }}>Ngrok Basic Auth</p>
      <p className="settings-security-desc">
        {ngrokConfigured
          ? "Basic auth is configured. Anyone accessing via ngrok will be prompted for credentials."
          : "Optionally protect your ngrok tunnel with HTTP basic auth (user:password)."}
      </p>
      <div className="settings-security-form">
        <input
          className="form-input"
          type="text"
          value={ngrokAuth}
          onChange={(e) => { setNgrokAuth(e.target.value); setNgrokError(null); setNgrokSuccess(null); }}
          placeholder="user:password"
          autoComplete="off"
        />
        {ngrokError && <div className="settings-security-error">{ngrokError}</div>}
        {ngrokSuccess && <div className="settings-security-success">{ngrokSuccess}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn-primary"
            onClick={handleSaveNgrokAuth}
            disabled={ngrokSaving || !ngrokAuth}
          >
            {ngrokSaving ? "..." : ngrokConfigured ? "Update" : "Save"}
          </button>
          {ngrokConfigured && (
            <button className="btn btn-danger-sm" onClick={handleClearNgrokAuth}>
              Remove
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Shortcuts Panel ───

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["⌘K"], description: "Focus session search" },
      { keys: ["⌘P"], description: "Open file explorer / focus file search" },
      { keys: ["Ctrl", "`"], description: "Switch to previous session (cycles MRU)" },
      { keys: ["Esc"], description: "Close bottom pane (plan / changes / files)" },
    ],
  },
  {
    title: "File Explorer",
    shortcuts: [
      { keys: ["↑", "↓"], description: "Navigate search results" },
      { keys: ["Enter"], description: "Open selected file" },
      { keys: ["Esc"], description: "Clear file search query, or close explorer" },
    ],
  },
  {
    title: "Terminal",
    shortcuts: [
      { keys: ["Shift", "Enter"], description: "Insert a newline without submitting" },
    ],
  },
  {
    title: "Session Search",
    shortcuts: [
      { keys: ["Esc"], description: "Clear search and blur input" },
    ],
  },
  {
    title: "Plan / Message Input",
    shortcuts: [
      { keys: ["Enter"], description: "Send message to agent" },
      { keys: ["Shift", "Enter"], description: "Insert newline" },
      { keys: ["Esc"], description: "Cancel inline comment" },
    ],
  },
];

function ShortcutsPanel() {
  return (
    <>
      <p className="settings-security-desc">
        All keyboard shortcuts available in AgentDock.
      </p>
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} className="shortcuts-group">
          <div className="shortcuts-group-title">{group.title}</div>
          <table className="shortcuts-table">
            <tbody>
              {group.shortcuts.map((s, i) => (
                <tr key={i} className="shortcuts-row">
                  <td className="shortcuts-keys">
                    {s.keys.map((k, ki) => (
                      <span key={ki}>
                        <kbd className="shortcuts-kbd">{k}</kbd>
                        {ki < s.keys.length - 1 && <span className="shortcuts-plus">+</span>}
                      </span>
                    ))}
                  </td>
                  <td className="shortcuts-desc">{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
