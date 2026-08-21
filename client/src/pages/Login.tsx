import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { setPassword as apiSetPassword } from "../api";
import { Icon } from "../components/Icon";
import "../styles/login.css";

export function Login({ setup }: { setup?: boolean }) {
  const { login, refresh } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    setError(null);
    const err = await login(password);
    if (err) {
      setError(err);
      setLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 4) {
      setError("Password must be at least 4 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    const result = await apiSetPassword(password);
    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      await refresh();
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="auth-head">
          <svg className="auth-mark" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <polyline points="6 8 10 12 6 16" />
            <line x1="14" y1="16" x2="18" y2="16" />
            <circle cx="7" cy="21" r="1" fill="currentColor" stroke="none" />
            <circle cx="12" cy="21" r="1" fill="currentColor" stroke="none" />
            <circle cx="17" cy="21" r="1" fill="currentColor" stroke="none" />
          </svg>
          <h1 className="auth-title">AgentDock</h1>
          <p className="auth-sub">
            {setup
              ? "Set a password before this instance is reachable from anything but this machine."
              : "This instance is reachable on your network."}
          </p>
        </div>

        <form className="auth-card" onSubmit={setup ? handleSetup : handleLogin}>
          {error && (
            <div className="auth-error" role="alert">
              <Icon name="alert" size={15} />
              <span>{error}</span>
            </div>
          )}

          <div className="auth-field">
            <label className="auth-label" htmlFor="auth-password">
              {setup ? "New password" : "Password"}
            </label>
            <div className="auth-input-wrap">
              <Icon name="lock" size={15} className="auth-input-icon" />
              <input
                id="auth-password"
                className="auth-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={setup ? "Choose a password" : "Password"}
                autoComplete={setup ? "new-password" : "current-password"}
                aria-invalid={error ? true : undefined}
                autoFocus
                disabled={loading}
              />
            </div>
          </div>

          {setup && (
            <div className="auth-field">
              <label className="auth-label" htmlFor="auth-confirm">Confirm password</label>
              <div className="auth-input-wrap">
                <Icon name="lock" size={15} className="auth-input-icon" />
                <input
                  id="auth-confirm"
                  className="auth-input"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat password"
                  autoComplete="new-password"
                  aria-invalid={error ? true : undefined}
                  disabled={loading}
                />
              </div>
            </div>
          )}

          <button
            className="auth-submit"
            type="submit"
            disabled={loading || !password || (setup ? !confirm : false)}
          >
            {loading ? (setup ? "Setting password…" : "Logging in…") : setup ? "Set password" : "Log in"}
          </button>

          {setup && (
            <p className="auth-hint">
              Stored as a hash under <code>~/.config/agentdock</code>. There is no account and no
              email — losing it means deleting that file.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
