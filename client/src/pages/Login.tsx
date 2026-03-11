import { useState } from "react";
import { motion } from "framer-motion";
import { Sparkles, ArrowRight, Lock } from "lucide-react";
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

  return (
    <div className="login-page">
      <motion.form
        className="login-card"
        onSubmit={setup ? handleSetup : handleLogin}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", duration: 0.3, bounce: 0 }}
      >
        {/* Logo block */}
        <div className="flex flex-col items-center gap-3 mb-6">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{
              width: 40,
              height: 40,
              background: "var(--accent)",
            }}
          >
            <Sparkles size={22} color="var(--bg)" strokeWidth={2.5} />
          </div>
          <h1 className="login-title">AgentDock</h1>
          <p className="login-subtitle">
            {setup
              ? "Set up your password to get started."
              : "Welcome back! Log in to continue."}
          </p>
        </div>

        {error && (
          <motion.div
            className="login-error"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
          >
            {error}
          </motion.div>
        )}

        <div className="flex flex-col gap-3 w-full">
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--text-dim)" }}
            />
            <input
              className="form-input login-input"
              style={{ paddingLeft: 36 }}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={setup ? "Choose a password" : "Password"}
              autoFocus
              disabled={loading}
            />
          </div>
          {setup && (
            <div className="relative">
              <Lock
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: "var(--text-dim)" }}
              />
              <input
                className="form-input login-input"
                style={{ paddingLeft: 36 }}
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirm password"
                disabled={loading}
              />
            </div>
          )}
        </div>

        <button
          className="btn btn-primary login-btn"
          type="submit"
          disabled={loading || !password || (setup ? !confirm : false)}
        >
          {loading ? (
            "..."
          ) : (
            <span className="flex items-center justify-center gap-2">
              {setup ? "Set Password" : "Log In"}
              <ArrowRight size={16} />
            </span>
          )}
        </button>

        {!setup && (
          <p
            className="text-[12px] mt-2 text-center"
            style={{ color: "var(--text-dim)" }}
          >
            First time? Set up password in Settings.
          </p>
        )}
      </motion.form>
    </div>
  );
}
