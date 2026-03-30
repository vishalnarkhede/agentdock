import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import React from "react";
import { fetchPreferences, updatePreferences } from "../api";

export interface Settings {
  // Appearance
  theme: "terminal" | "dark" | "midnight" | "light" | "minimal" | "glass" | "notion" | "macos" | "win98";
  fontSize: "small" | "medium" | "large";

  // Terminal
  cursorBlink: boolean;
  scrollback: number;
  terminalFontSize: number;
  customKeyboard: boolean;

  // Notifications
  notificationsEnabled: boolean;
}

const DEFAULTS: Settings = {
  theme: "midnight",
  fontSize: "medium",
  cursorBlink: true,
  scrollback: 10000,
  terminalFontSize: 14,
  notificationsEnabled: true,
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
