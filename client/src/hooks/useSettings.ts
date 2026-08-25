import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import React from "react";
import { fetchPreferences, updatePreferences } from "../api";
import type { AgentType } from "../types";

export interface Settings {
  // Appearance
  theme: "cockpit" | "terminal" | "dark" | "midnight" | "light" | "minimal" | "glass" | "notion" | "macos" | "win98";
  fontSize: "small" | "medium" | "large";

  // Terminal
  cursorBlink: boolean;
  scrollback: number;
  terminalFontSize: number;
  customKeyboard: boolean;

  // Notifications
  notificationsEnabled: boolean;
  /** Interrupt when an agent starts waiting on you. */
  notifyBlocked: boolean;
  /** Interrupt when an agent finishes and becomes reviewable. */
  notifyReview: boolean;
  /** Hold all notifications between quietStart and quietEnd. */
  notifyQuietEnabled: boolean;
  notifyQuietStart: number;
  notifyQuietEnd: number;
  /** Coalesce notifications fired within a few seconds of each other. */
  notifyBatchEnabled: boolean;
  /** Re-notify about an agent that is still waiting on you. */
  notifyRemindEnabled: boolean;

  // Agents
  /** Agent preselected when starting a session. */
  defaultAgent: AgentType;
  /** Whether that agent starts with its permission prompts disabled. */
  defaultSkipPermissions: boolean;

  // Worktrees
  /** Shell command run inside a freshly created worktree. */
  worktreePostCreate: string;
  /** Prefix for generated worktree branch names. */
  worktreeBranchPrefix: string;
  /** Remove a session's worktree once its branch has merged cleanly. */
  worktreeAutoRemove: boolean;
}

const DEFAULTS: Settings = {
  theme: "cockpit",
  fontSize: "medium",
  cursorBlink: true,
  scrollback: 10000,
  terminalFontSize: 14,
  notificationsEnabled: true,
  notifyBlocked: true,
  notifyReview: true,
  notifyQuietEnabled: false,
  notifyQuietStart: 21,
  notifyQuietEnd: 8,
  notifyBatchEnabled: true,
  notifyRemindEnabled: false,
  defaultAgent: "claude",
  defaultSkipPermissions: false,
  worktreePostCreate: "",
  worktreeBranchPrefix: "wt-",
  worktreeAutoRemove: false,
  customKeyboard: typeof window !== "undefined" && window.innerWidth <= 768,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("settings");
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed };
    }
  } catch {
    // ignore corrupt data
  }
  // Migrate from old individual keys
  const oldTheme = localStorage.getItem("theme");
  const oldFontSize = localStorage.getItem("fontsize");
  const migrated = { ...DEFAULTS };
  if (oldTheme) migrated.theme = oldTheme as Settings["theme"];
  if (oldFontSize) migrated.fontSize = oldFontSize as Settings["fontSize"];
  return migrated;
}

function persistSettings(s: Settings) {
  localStorage.setItem("settings", JSON.stringify(s));
  // Clean up old keys
  localStorage.removeItem("theme");
  localStorage.removeItem("fontsize");
}

function applyToDOM(s: Settings) {
  document.documentElement.setAttribute("data-theme", s.theme);
  document.documentElement.setAttribute("data-fontsize", s.fontSize);
}

// Apply immediately on module load (before React renders) — same pattern as old ThemeSelector
applyToDOM(loadSettings());

interface SettingsContextValue {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [serverLoaded, setServerLoaded] = useState(false);

  // On mount, fetch from server and merge (server wins for persisted values)
  useEffect(() => {
    fetchPreferences().then((serverPrefs) => {
      if (serverPrefs && Object.keys(serverPrefs).length > 0) {
        setSettings((prev) => {
          const merged = { ...prev };
          if (serverPrefs.theme) merged.theme = serverPrefs.theme;
          if (serverPrefs.fontSize) merged.fontSize = serverPrefs.fontSize;
          if (serverPrefs.cursorBlink !== undefined) merged.cursorBlink = serverPrefs.cursorBlink;
          if (serverPrefs.scrollback !== undefined) merged.scrollback = serverPrefs.scrollback;
          if (serverPrefs.terminalFontSize !== undefined) merged.terminalFontSize = serverPrefs.terminalFontSize;
          if (serverPrefs.notificationsEnabled !== undefined) merged.notificationsEnabled = serverPrefs.notificationsEnabled;
          if (serverPrefs.customKeyboard !== undefined) merged.customKeyboard = serverPrefs.customKeyboard;
          if (serverPrefs.notifyBlocked !== undefined) merged.notifyBlocked = serverPrefs.notifyBlocked;
          if (serverPrefs.notifyReview !== undefined) merged.notifyReview = serverPrefs.notifyReview;
          if (serverPrefs.notifyQuietEnabled !== undefined) merged.notifyQuietEnabled = serverPrefs.notifyQuietEnabled;
          if (serverPrefs.notifyQuietStart !== undefined) merged.notifyQuietStart = serverPrefs.notifyQuietStart;
          if (serverPrefs.notifyQuietEnd !== undefined) merged.notifyQuietEnd = serverPrefs.notifyQuietEnd;
          if (serverPrefs.notifyBatchEnabled !== undefined) merged.notifyBatchEnabled = serverPrefs.notifyBatchEnabled;
          if (serverPrefs.notifyRemindEnabled !== undefined) merged.notifyRemindEnabled = serverPrefs.notifyRemindEnabled;
          if (serverPrefs.defaultAgent !== undefined) merged.defaultAgent = serverPrefs.defaultAgent;
          if (serverPrefs.defaultSkipPermissions !== undefined) merged.defaultSkipPermissions = serverPrefs.defaultSkipPermissions;
          if (serverPrefs.worktreePostCreate !== undefined) merged.worktreePostCreate = serverPrefs.worktreePostCreate;
          if (serverPrefs.worktreeBranchPrefix !== undefined) merged.worktreeBranchPrefix = serverPrefs.worktreeBranchPrefix;
          if (serverPrefs.worktreeAutoRemove !== undefined) merged.worktreeAutoRemove = serverPrefs.worktreeAutoRemove;
          return merged;
        });
      }
      setServerLoaded(true);
    }).catch(() => setServerLoaded(true));
  }, []);

  // Apply DOM attributes whenever settings change
  useEffect(() => {
    applyToDOM(settings);
    persistSettings(settings);
  }, [settings]);

  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    // Sync to server
    updatePreferences({ [key]: value }).catch(() => {});
  }, []);

  return React.createElement(
    SettingsContext.Provider,
    { value: { settings, updateSetting } },
    children,
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
