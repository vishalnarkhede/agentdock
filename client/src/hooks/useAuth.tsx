import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { fetchAuthStatus, login as apiLogin, logout as apiLogout } from "../api";

interface AuthState {
  /** true = auth check done */
  ready: boolean;
  /** true = password is configured on server */
  enabled: boolean;
  /** true = user has valid session cookie */
  loggedIn: boolean;
  login: (password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  /** re-check auth status (e.g. after setting password) */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await fetchAuthStatus();
      setEnabled(status.enabled);
      setLoggedIn(status.loggedIn);
    } catch {
      // server unreachable — treat as logged in (no auth wall)
      setEnabled(false);
      setLoggedIn(true);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (password: string): Promise<string | null> => {
    const result = await apiLogin(password);
    if (result.ok) {
      setLoggedIn(true);
      return null;
    }
    return result.error || "Login failed";
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setLoggedIn(false);
  }, []);

  return (
    <AuthContext.Provider value={{ ready, enabled, loggedIn, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
