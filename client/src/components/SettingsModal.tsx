import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useSettings, type Settings } from "../hooks/useSettings";
import { useAuth } from "../hooks/useAuth";
import {
  fetchSettingsHealth,
  fetchHookState,
  installHooks,
  type HookState,
  fetchSettingsRepos,
  fetchBasePath,
  updateBasePath,
  addSettingsRepo,
  deleteSettingsRepo,
  setPassword as apiSetPassword,
  fetchMetaPropertyPresets,
  saveMetaPropertyPresets,
  fetchNgrokBasicAuthStatus,
  setNgrokBasicAuth as apiSetNgrokBasicAuth,
  deleteNgrokBasicAuth as apiDeleteNgrokBasicAuth,
  type SettingsHealth,
} from "../api";
import type { RepoConfig, MetaPropertyPreset, AgentType } from "../types";
import { Icon, type IconName } from "./Icon";
import { PhoneLinkPanel } from "./PhoneLink";
import { notify } from "../notify";
import "../styles/settings-panes.css";

type Category =
  | "appearance"
  | "terminal"
  | "notifications"
  | "repos"
  | "agents"
  | "worktrees"
  | "meta"
  | "security"
  | "health"
  | "shortcuts";

const CATEGORIES: { id: Category; label: string; icon: IconName }[] = [
  { id: "repos", label: "Repositories", icon: "repo" },
  { id: "agents", label: "Agents", icon: "sparkle" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "worktrees", label: "Worktrees", icon: "branch" },
  { id: "meta", label: "Session properties", icon: "filter" },
  { id: "security", label: "Access", icon: "lock" },
  { id: "appearance", label: "Appearance", icon: "eye" },
  { id: "terminal", label: "Terminal", icon: "term" },
  { id: "health", label: "Health", icon: "alert" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
];

const PANE_META: Record<Category, { title: string; blurb: string }> = {
  repos: {
    title: "Repositories",
    blurb: "The repos AgentDock offers when you start a session.",
  },
  agents: {
    title: "Agents",
    blurb: "Which CLI runs, and with what flags.",
  },
  notifications: {
    title: "Notifications",
    blurb:
      "An agent that is blocked costs you nothing until you notice it, and then it costs you everything you had loaded in your head. Three transitions are worth interrupting for.",
  },
  worktrees: {
    title: "Worktrees",
    blurb: "Where they go, what runs after creation, and when they get cleaned up.",
  },
  meta: {
    title: "Session properties",
    blurb: "Your own labels for grouping the queue \u2014 priority, customer, team.",
  },
  security: {
    title: "Access",
    blurb: "The address to open on your phone, the password that guards it, and the ngrok tunnel.",
  },
  appearance: {
    title: "Appearance",
    blurb: "Theme and type size.",
  },
  terminal: {
    title: "Terminal",
    blurb: "Terminal font, scrollback and the on-screen keyboard.",
  },
  health: {
    title: "Health",
    blurb: "What AgentDock shells out to. A missing tool is a broken feature, not a warning.",
  },
  shortcuts: {
    title: "Shortcuts",
    blurb: "Every key AgentDock binds.",
  },
};

const THEMES: { id: Settings["theme"]; label: string }[] = [
  { id: "cockpit", label: "Cockpit" },
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

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const FONT_SIZES: { id: Settings["fontSize"]; label: string }[] = [
  { id: "small", label: "S" },
  { id: "medium", label: "M" },
  { id: "large", label: "L" },
];

const SCROLLBACK_OPTIONS = [1000, 5000, 10000, 50000];
const TERM_FONT_SIZES = [12, 13, 14, 15, 16];

/** Tools AgentDock cannot work without. gh, psql and the Cursor CLI are optional. */
const REQUIRED_TOOLS: (keyof SettingsHealth)[] = ["tmux", "claude", "git", "bun"];

/** One badge, and only for a tool whose absence actually breaks something. */
function navBadge(id: Category, health: SettingsHealth | null): { text: string } | null {
  if (id !== "health" || !health) return null;
  const missing = REQUIRED_TOOLS.filter((k) => !health[k]?.installed).length;
  return missing > 0 ? { text: String(missing) } : null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const [category, setCategory] = useState<Category>("repos");
  const { settings, updateSetting } = useSettings();
  const [notifStatus, setNotifStatus] = useState<string | null>(null);
  const [health, setHealth] = useState<SettingsHealth | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchSettingsHealth().then(setHealth).catch(() => setHealth(null));
  }, [open]);

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
      /* The click is half of what is being tested, and this one has no session
         to open — so it reports back here instead, which is also the only
         visible proof when the window was already in front. */
      notify("AgentDock", "Notifications are working. Click this to test the click.", {
        tag: "settings-test",
        onClick: () => setNotifStatus("Clicked — a real one would open its session"),
      });
      setNotifStatus("Sent! Check your OS notification center, then click it");
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
            {CATEGORIES.map((cat) => {
              const badge = navBadge(cat.id, health);
              return (
                <button
                  key={cat.id}
                  data-tutorial={`settings-tab-${cat.id}`}
                  className={`settings-sidebar-btn set-nav-item ${category === cat.id ? "settings-sidebar-btn-active" : ""}`}
                  onClick={() => setCategory(cat.id)}
                  aria-current={category === cat.id ? "page" : undefined}
                >
                  <Icon name={cat.icon} size={14} />
                  <span className="set-nav-label">{cat.label}</span>
                  {badge && (
                    <span className="set-nav-badge set-nav-badge-warn" title="tools not installed">
                      {badge.text}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="settings-panel" data-tutorial="settings-panel">
            <div className="set-head">
              <span className="set-head-title">{PANE_META[category].title}</span>
              <span className="set-head-blurb">{PANE_META[category].blurb}</span>
            </div>
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
                  <label className="settings-label">Custom Keyboard</label>
                  <button
                    className={`settings-toggle ${settings.customKeyboard ? "settings-toggle-on" : ""}`}
                    onClick={() => updateSetting("customKeyboard", !settings.customKeyboard)}
                    role="switch"
                    aria-checked={settings.customKeyboard}
                    title="Use agentdock's custom keyboard (recommended on mobile)"
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
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
              <div className="set-pane">
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
                <div className="settings-row settings-notif-row">
                  <div className="settings-notif-copy">
                    <label className="settings-label">An agent starts waiting on you</label>
                    <span className="settings-notif-hint">
                      It asked a question or wants permission, and cannot continue.
                    </span>
                  </div>
                  <button
                    className={`settings-toggle ${settings.notifyBlocked ? "settings-toggle-on" : ""}`}
                    onClick={() => updateSetting("notifyBlocked", !settings.notifyBlocked)}
                    disabled={!settings.notificationsEnabled}
                    role="switch"
                    aria-checked={settings.notifyBlocked}
                    aria-label="Notify when an agent is waiting on you"
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>

                <div className="settings-row settings-notif-row">
                  <div className="settings-notif-copy">
                    <label className="settings-label">An agent becomes reviewable</label>
                    <span className="settings-notif-hint">
                      It finished its turn. Nothing is blocked, but the change cannot ship yet.
                    </span>
                  </div>
                  <button
                    className={`settings-toggle ${settings.notifyReview ? "settings-toggle-on" : ""}`}
                    onClick={() => updateSetting("notifyReview", !settings.notifyReview)}
                    disabled={!settings.notificationsEnabled}
                    role="switch"
                    aria-checked={settings.notifyReview}
                    aria-label="Notify when an agent becomes reviewable"
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>

                <div className="settings-row settings-notif-row">
                  <div className="settings-notif-copy">
                    <label className="settings-label">Stay quiet overnight</label>
                    <span className="settings-notif-hint">
                      Blocked agents still stack up in the queue. Nothing buzzes.
                    </span>
                  </div>
                  <div className="settings-quiet-controls">
                    <select
                      className="settings-quiet-hour"
                      value={settings.notifyQuietStart}
                      onChange={(e) => updateSetting("notifyQuietStart", Number(e.target.value))}
                      disabled={!settings.notificationsEnabled || !settings.notifyQuietEnabled}
                      aria-label="Quiet hours start"
                    >
                      {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                    </select>
                    <span className="settings-quiet-sep">to</span>
                    <select
                      className="settings-quiet-hour"
                      value={settings.notifyQuietEnd}
                      onChange={(e) => updateSetting("notifyQuietEnd", Number(e.target.value))}
                      disabled={!settings.notificationsEnabled || !settings.notifyQuietEnabled}
                      aria-label="Quiet hours end"
                    >
                      {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
                    </select>
                    <button
                      className={`settings-toggle ${settings.notifyQuietEnabled ? "settings-toggle-on" : ""}`}
                      onClick={() => updateSetting("notifyQuietEnabled", !settings.notifyQuietEnabled)}
                      disabled={!settings.notificationsEnabled}
                      role="switch"
                      aria-checked={settings.notifyQuietEnabled}
                      aria-label="Enable quiet hours"
                    >
                      <span className="settings-toggle-knob" />
                    </button>
                  </div>
                </div>

                <div className="settings-row settings-notif-row">
                  <div className="settings-notif-copy">
                    <label className="settings-label">Hold notifications for 30 seconds</label>
                    <span className="settings-notif-hint">
                      Two agents finishing together arrive as one notification instead of two.
                    </span>
                  </div>
                  <button
                    className={`settings-toggle ${settings.notifyBatchEnabled ? "settings-toggle-on" : ""}`}
                    onClick={() => updateSetting("notifyBatchEnabled", !settings.notifyBatchEnabled)}
                    disabled={!settings.notificationsEnabled}
                    role="switch"
                    aria-checked={settings.notifyBatchEnabled}
                    aria-label="Hold notifications for 30 seconds"
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>

                <div className="settings-row settings-notif-row">
                  <div className="settings-notif-copy">
                    <label className="settings-label">Keep reminding me about blocked agents</label>
                    <span className="settings-notif-hint">
                      Re-notify every 15 minutes until answered. Off by default because it becomes
                      noise.
                    </span>
                  </div>
                  <button
                    className={`settings-toggle ${settings.notifyRemindEnabled ? "settings-toggle-on" : ""}`}
                    onClick={() => updateSetting("notifyRemindEnabled", !settings.notifyRemindEnabled)}
                    disabled={!settings.notificationsEnabled}
                    role="switch"
                    aria-checked={settings.notifyRemindEnabled}
                    aria-label="Keep reminding me about blocked agents"
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

                <div className="set-note">
                  <Icon name="alert" size={14} />
                  <span>
                    A notification you learn to dismiss is worse than none. These three transitions
                    are the only ones that ever mean &ldquo;stop what you are doing&rdquo; &mdash;
                    everything else belongs in the queue, not on your screen.
                  </span>
                </div>
              </div>
            )}
            {category === "repos" && <ReposPanel />}
            {category === "agents" && <AgentsPanel health={health} />}
            {category === "worktrees" && <WorktreesPanel />}
            {category === "meta" && <MetaPropertiesPanel />}
            {category === "security" && (
              <>
                <PhoneLinkPanel />
                <div className="settings-section-divider" />
                <SecurityPanel />
              </>
            )}
            {category === "health" && <><HookPanel /><HealthPanel health={health} /></>}
            {category === "shortcuts" && <ShortcutsPanel />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Health Panel ───

function HookPanel() {
  const [state, setState] = useState<HookState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => fetchHookState().then(setState).catch(() => setState(null));
  useEffect(() => { load(); }, []);

  const handleInstall = async () => {
    setBusy(true);
    setErr(null);
    try {
      /* `ok` on the state means every hook is installed, not that the install
         worked — reading it as the latter reported "Install failed" on a
         partial install that had in fact just succeeded. A failure throws. */
      setState(await installHooks());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  return (
    <div className="settings-hooks">
      <div className="settings-row">
        <label className="settings-label">Status hooks</label>
        <div className="settings-hooks-actions">
          <span className={`settings-hook-badge ${state.ok ? "settings-hook-ok" : "settings-hook-bad"}`}>
            {state.ok ? `all ${state.installed.length} installed` : `${state.missing.length} missing`}
          </span>
          {!state.ok && (
            <button className="settings-test-btn" onClick={handleInstall} disabled={busy}>
              {busy ? "Installing…" : "Install"}
            </button>
          )}
        </div>
      </div>

      <p className="settings-security-desc">
        Without these, AgentDock has to guess an agent&rsquo;s state by reading its terminal — the
        difference between knowing an agent is blocked and finding out ninety seconds later.
        Installing writes to <code>{state.settingsPath}</code>, outside AgentDock&rsquo;s own config.
      </p>

      {err && <div className="settings-error">{err}</div>}

      <div className="settings-hook-list">
        {state.events.map((e) => {
          const on = state.installed.includes(e.event);
          return (
            <div key={e.event} className="settings-hook-row">
              <span className={`settings-hook-dot ${on ? "settings-hook-dot-on" : ""}`} />
              <span className="settings-hook-event">{e.event}</span>
              <span className="settings-hook-status">{e.status}</span>
              <span className="settings-hook-means">{e.means}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HealthPanel({ health }: { health: SettingsHealth | null }) {
  if (!health) return <div className="settings-loading">Checking tools...</div>;

  const tools = [
    { name: "tmux", ...health.tmux, required: true, install: "brew install tmux  •  apt install tmux" },
    { name: "claude", ...health.claude, required: true, install: "npm i -g @anthropic-ai/claude-code  •  claude.ai/code" },
    { name: "cursor (agent CLI)", ...health.cursor, required: false, install: "Install Cursor IDE from cursor.com" },
    { name: "git", ...health.git, required: true, install: "brew install git  •  apt install git" },
    { name: "gh (GitHub CLI)", ...health.gh, required: false, install: "brew install gh  •  cli.github.com" },
    { name: "bun", ...health.bun, required: true, install: "curl -fsSL https://bun.sh/install | bash" },
    { name: "psql", ...health.psql, required: false, install: "brew install postgresql  •  apt install postgresql-client" },
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
                <span>{tool.required ? "missing (required)" : "missing (optional)"}</span>
                <code className="settings-health-install">{tool.install}</code>
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Agents Panel ───

const AGENTS: {
  id: AgentType;
  label: string;
  cli: string;
  skipFlag: string;
  healthKey: "claude" | "cursor";
}[] = [
  { id: "claude", label: "Claude Code", cli: "claude", skipFlag: "--dangerously-skip-permissions", healthKey: "claude" },
  { id: "cursor", label: "Cursor Agent", cli: "agent", skipFlag: "--yolo", healthKey: "cursor" },
];

/** `gh --version` answers "gh version 2.86.0 (2026-01-21)". Only the number fits a tag. */
function shortVersion(v: string): string {
  return v.match(/\d+[\w.-]*/)?.[0] || v;
}

// Abbreviated form of the allow-list in server/src/services/session-manager.ts.
const CLAUDE_ALLOWED = "Read Edit Write Glob Grep 'Bash(git:*)' 'Bash(gh:*)' \u2026";

function AgentsPanel({ health }: { health: SettingsHealth | null }) {
  const { settings, updateSetting } = useSettings();
  const skip = settings.defaultSkipPermissions;
  const chosen = AGENTS.find((a) => a.id === settings.defaultAgent) || AGENTS[0];
  const cmd =
    chosen.id === "claude"
      ? skip
        ? "claude --dangerously-skip-permissions"
        : `claude --allowedTools ${CLAUDE_ALLOWED}`
      : skip
        ? "agent --yolo"
        : "agent";

  return (
    <div className="set-pane">
      <div className="set-section">
        <span className="set-section-title">Default for new sessions</span>
        <div className="settings-row">
          <label className="settings-label" id="default-agent-label">Agent</label>
          <div className="settings-segmented" role="group" aria-labelledby="default-agent-label">
            {AGENTS.map((a) => (
              <button
                key={a.id}
                className={`settings-segmented-btn ${settings.defaultAgent === a.id ? "settings-segmented-btn-active" : ""}`}
                onClick={() => updateSetting("defaultAgent", a.id)}
                aria-pressed={settings.defaultAgent === a.id}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row settings-notif-row">
          <div className="settings-notif-copy">
            <label className="settings-label">Start without permission prompts</label>
            <span className="settings-notif-hint">
              Passes <code>{chosen.skipFlag}</code>. Without it, Claude runs against a fixed
              allow-list and stops to ask for anything outside it.
            </span>
          </div>
          <button
            className={`settings-toggle ${skip ? "settings-toggle-on" : ""}`}
            onClick={() => updateSetting("defaultSkipPermissions", !skip)}
            role="switch"
            aria-checked={skip}
            aria-label="Start new sessions without permission prompts"
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
      </div>

      <div className="set-section">
        <span className="set-section-title">What actually runs</span>
        <div className="set-group">
          {AGENTS.map((a) => {
            const tool = health ? health[a.healthKey] : null;
            return (
              <div key={a.id} className="set-group-row">
                <span className={`set-dot ${tool ? (tool.installed ? "set-dot-on" : "set-dot-off") : ""}`} />
                <div className="set-copy">
                  <span className="set-copy-title">{a.label}</span>
                  <span className="set-copy-hint">
                    <code>{a.cli}</code>
                    {tool ? (tool.installed ? ` \u00b7 ${shortVersion(tool.version)}` : " \u00b7 not installed") : ""}
                  </span>
                </div>
                {settings.defaultAgent === a.id && <span className="set-tag">default</span>}
              </div>
            );
          })}
        </div>
        <code className="set-cmd">{cmd}</code>
        <div className="set-note">
          <Icon name="alert" size={14} />
          <span>
            Claude sessions also get <code>--append-system-prompt-file</code>, one
            {" "}<code>--add-dir</code> per worktree, and <code>-n</code> with the session name. Cursor
            takes neither, so multi-repo Cursor sessions see only the first worktree.
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Worktrees Panel ───

function WorktreesPanel() {
  const { settings, updateSetting } = useSettings();
  const [basePath, setBasePath] = useState("");
  const [postCreate, setPostCreate] = useState(settings.worktreePostCreate);
  const [prefix, setPrefix] = useState(settings.worktreeBranchPrefix);

  useEffect(() => { fetchBasePath().then(setBasePath).catch(() => setBasePath("")); }, []);

  const commit = <K extends "worktreePostCreate" | "worktreeBranchPrefix">(key: K, value: string) => {
    if (value !== settings[key]) updateSetting(key, value);
  };

  return (
    <div className="set-pane">
      <div className="set-section">
        <span className="set-section-title">Where they go</span>
        <div className="set-path">
          <Icon name="folder" size={15} />
          <span className="set-mono">
            {basePath || "\u2026"}/.worktrees/&lt;session&gt;/&lt;repo&gt;
          </span>
        </div>
        <div className="set-note">
          <Icon name="alert" size={14} />
          <span>
            One directory per session, one subdirectory per repo in it. The base path is the same one
            repos are scanned from &mdash; change it under Repositories.
          </span>
        </div>
      </div>

      <div className="set-section">
        <span className="set-section-title">After creation</span>
        <div className="set-field">
          <label className="set-field-label" htmlFor="wt-post-create">Post-create command</label>
          <input
            id="wt-post-create"
            className="set-input"
            value={postCreate}
            placeholder="bun install"
            onChange={(e) => setPostCreate(e.target.value)}
            onBlur={() => commit("worktreePostCreate", postCreate)}
            onKeyDown={(e) => { if (e.key === "Enter") commit("worktreePostCreate", postCreate); }}
            spellCheck={false}
          />
          <span className="set-copy-hint">
            Runs once in each new worktree, before the agent starts &mdash; the thing that saves an
            agent its first two minutes on <code>npm install</code>.
          </span>
        </div>
      </div>

      <div className="set-section">
        <span className="set-section-title">Naming</span>
        <div className="set-field">
          <label className="set-field-label" htmlFor="wt-prefix">Branch prefix</label>
          <input
            id="wt-prefix"
            className="set-input set-input-narrow"
            value={prefix}
            placeholder="wt-"
            onChange={(e) => setPrefix(e.target.value)}
            onBlur={() => commit("worktreeBranchPrefix", prefix)}
            onKeyDown={(e) => { if (e.key === "Enter") commit("worktreeBranchPrefix", prefix); }}
            spellCheck={false}
          />
          <span className="set-copy-hint">
            A session started from a ticket uses the ticket ID as its branch. Everything else gets
            <code>{(prefix || "wt-") + "<short id>"}</code>, which is what keeps two sessions on the
            same repo from colliding.
          </span>
        </div>
      </div>

      <div className="set-section">
        <span className="set-section-title">Cleanup</span>
        <div className="set-group">
          <div className="set-group-row set-group-row-top">
            <div className="set-copy">
              <span className="set-copy-title">Remove the worktree after a clean merge</span>
              <span className="set-copy-hint">
                Deleting a session already removes its worktree. This also clears the ones whose
                branch has landed, so a merged session does not keep a checkout alive.
              </span>
            </div>
            <button
              className={`settings-toggle ${settings.worktreeAutoRemove ? "settings-toggle-on" : ""}`}
              onClick={() => updateSetting("worktreeAutoRemove", !settings.worktreeAutoRemove)}
              role="switch"
              aria-checked={settings.worktreeAutoRemove}
              aria-label="Remove the worktree after a clean merge"
            >
              <span className="settings-toggle-knob" />
            </button>
          </div>
        </div>
      </div>
    </div>
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
      { keys: ["Ctrl", "Shift", "["], description: "Go back to previous session (MRU)" },
      { keys: ["Ctrl", "Shift", "]"], description: "Go forward to next session (MRU)" },
      { keys: ["Esc"], description: "Close bottom pane (plan / changes / files)" },
    ],
  },
  {
    title: "File Explorer",
    shortcuts: [
      { keys: ["↑", "↓"], description: "Navigate search results" },
      { keys: ["Enter"], description: "Open selected file" },
      { keys: ["Esc"], description: "Clear file search query, or close explorer" },
      { keys: ["⌘["], description: "Go back to the previous file / line (⌘{ works too)" },
      { keys: ["⌘]"], description: "Go forward again (⌘} works too)" },
      { keys: ["⌘F"], description: "Search text in open file" },
      { keys: ["Enter"], description: "Next match in file" },
      { keys: ["Shift", "Enter"], description: "Previous match in file" },
      { keys: ["Esc"], description: "Close in-file search" },
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
