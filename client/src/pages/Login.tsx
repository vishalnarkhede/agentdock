import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { setPassword as apiSetPassword } from "../api";

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

  if (setup) {
    return (
      <div className="login-page">
        <div className="login-shell">
          <div className="login-topbar">
            <span className="login-brand">AgentDock</span>
          </div>
          <form className="login-card" onSubmit={handleSetup}>
            <h1 className="login-title">Set Password</h1>
            {error && <div className="login-error">{error}</div>}
            <input
              className="form-input login-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Choose a password"
              autoFocus
              disabled={loading}
            />
            <input
              className="form-input login-input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password"
              disabled={loading}
            />
            <button className="btn btn-primary login-btn" type="submit" disabled={loading || !password || !confirm}>
              {loading ? "..." : "Set Password"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-shell">
        <div className="login-topbar">
          <span className="login-brand">AgentDock</span>
        </div>
        <form className="login-card" onSubmit={handleLogin}>
          <h1 className="login-title">Log In</h1>
          {error && <div className="login-error">{error}</div>}
          <input
            className="form-input login-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            disabled={loading}
          />
          <button className="btn btn-primary login-btn" type="submit" disabled={loading || !password}>
            {loading ? "..." : "Log In"}
          </button>
        </form>
      </div>
    </div>
  );
}
