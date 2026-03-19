import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import React from "react";
import { fetchPreferences, updatePreferences } from "../api";

interface PreferencesContextValue {
  prefs: Record<string, any>;
  loaded: boolean;
  updatePref: (key: string, value: any) => void;
  updatePrefs: (partial: Record<string, any>) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Record<string, any>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchPreferences().then((p) => {
      setPrefs(p);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const updatePref = useCallback((key: string, value: any) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
    updatePreferences({ [key]: value }).catch(() => {});
  }, []);

  const updatePrefs = useCallback((partial: Record<string, any>) => {
    setPrefs((prev) => ({ ...prev, ...partial }));
    updatePreferences(partial).catch(() => {});
  }, []);

  return React.createElement(
    PreferencesContext.Provider,
    { value: { prefs, loaded, updatePref, updatePrefs } },
    children,
  );
}

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used within PreferencesProvider");
  return ctx;
}
