import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { SettingsModal } from "./SettingsModal";
import { createSession, fetchPreferences, updatePreferences, fetchNgrokStatus, startNgrok, stopNgrok } from "../api";
import { useAuth } from "../hooks/useAuth";
import { isDemo } from "../demo";
import { useMobileNav } from "../MobileNavContext";
import type { NgrokStatus } from "../api";

export interface QuickLaunch {
  id: string;
  label: string;
  sessionName?: string;
  targets: string[];
  agentType?: string;
}


export function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const mobileNav = useMobileNav();
  const sessionTitle = mobileNav?.sessionTitle ?? "";
  const inSession = mobileNav?.inSession ?? false;
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fixingMe, setFixingMe] = useState(false);
  const [talkingToMe, setTalkingToMe] = useState(false);
  const [ngrok, setNgrok] = useState<NgrokStatus>({ running: false, url: null });
  const [ngrokLoading, setNgrokLoading] = useState(false);
  const [quickLaunches, setQuickLaunches] = useState<QuickLaunch[]>([]);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { enabled: authEnabled, logout } = useAuth();

  const loadQuickLaunches = useCallback(() => {
    fetchPreferences().then((p) => {
      if (p.quickLaunches) setQuickLaunches(p.quickLaunches);
    });
  }, []);

  useEffect(() => {
    loadQuickLaunches();
    const handler = () => loadQuickLaunches();
    window.addEventListener("agentdock-quick-launches-changed", handler);
    return () => window.removeEventListener("agentdock-quick-launches-changed", handler);
  }, [loadQuickLaunches]);

  const handleQuickLaunch = useCallback(async (ql: QuickLaunch) => {
    if (launchingId) return;
    setLaunchingId(ql.id);
    try {
      const { sessions } = await createSession({
        targets: ql.targets,
        name: ql.sessionName,
        dangerouslySkipPermissions: true,
        agentType: (ql.agentType as any) || "claude",
        grouped: true,
      });
      if (sessions?.[0]) {
        navigate(`/?session=${sessions[0]}`);
        window.dispatchEvent(new CustomEvent("agentdock-mobile-show-terminal"));
      }
    } catch (err) {
      console.error("Failed to launch:", err);
    } finally {
      setLaunchingId(null);
    }
  }, [launchingId, navigate]);

  const removeQuickLaunch = useCallback(async (id: string) => {
    const updated = quickLaunches.filter(q => q.id !== id);
    setQuickLaunches(updated);
    await updatePreferences({ quickLaunches: updated });
  }, [quickLaunches]);

  const handleFixMe = async () => {
    if (fixingMe) return;
    setFixingMe(true);
    try {
      const { sessions } = await createSession({ targets: ["agentdock"], dangerouslySkipPermissions: true });
      if (sessions?.[0]) {
        navigate(`/?session=${sessions[0]}`);
        window.dispatchEvent(new CustomEvent("agentdock-mobile-show-terminal"));
      }
    } catch (err) {
      console.error("Failed to create fix-me session:", err);
    } finally {
      setFixingMe(false);
    }
  };

  const handleTalkToMe = async () => {
    if (talkingToMe) return;
    setTalkingToMe(true);
    try {
      const { sessions } = await createSession({ targets: [], name: "general-chat", dangerouslySkipPermissions: true });
      if (sessions?.[0]) {
        navigate(`/?session=${sessions[0]}`);
        window.dispatchEvent(new CustomEvent("agentdock-mobile-show-terminal"));
      }
    } catch (err) {
      console.error("Failed to create talk session:", err);
    } finally {
      setTalkingToMe(false);
    }
  };

  // Ngrok: load status on mount and poll while running
  useEffect(() => {
    if (isDemo()) return;
    fetchNgrokStatus().then(setNgrok);
  }, []);

  useEffect(() => {
    if (!ngrok.running) return;
    const id = setInterval(() => fetchNgrokStatus().then(setNgrok), 5000);
    return () => clearInterval(id);
  }, [ngrok.running]);

  const [ngrokToast, setNgrokToast] = useState<string | null>(null);
  const ngrokToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleNgrokToggle = async () => {
    setNgrokLoading(true);
    try {
      if (ngrok.running) {
        await stopNgrok();
        setNgrok({ running: false, url: null });
        setNgrokToast(null);
      } else {
        const status = await startNgrok();
        setNgrok(status);
        if (status.url) {
          setNgrokToast(status.url);
          if (ngrokToastTimer.current) clearTimeout(ngrokToastTimer.current);
          ngrokToastTimer.current = setTimeout(() => setNgrokToast(null), 8000);
        }
      }
    } finally {
      setNgrokLoading(false);
    }
  };

  // Tutorial: open settings modal on request
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener("agentdock-tutorial-open-settings", handler);
    return () => window.removeEventListener("agentdock-tutorial-open-settings", handler);
  }, []);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menuOpen]);

  // Close menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <>
    <header className="header">
      {/* Back button — mobile only, non-root pages or when in session */}
      {(location.pathname !== "/" || inSession) && (
        <button
          className="header-back-btn header-back-btn-mobile"
          onClick={() => inSession ? mobileNav?.goBack() : navigate(-1)}
          aria-label="Back"
        >
          ‹
        </button>
      )}
      {/* Session title — mobile only, shown when in session */}
      {sessionTitle && (
        <span className="header-session-title-mobile">{sessionTitle}</span>
      )}
      {/* Logo — mobile only, shown on session list (root, not in session) */}
      {location.pathname === "/" && !inSession && (
        <Link to="/" className="header-title header-title-mobile-home">
          <svg className="header-logo" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <polyline points="6 8 10 12 6 16" />
            <line x1="14" y1="16" x2="18" y2="16" />
            <circle cx="7" cy="21" r="1" fill="currentColor" stroke="none" />
            <circle cx="12" cy="21" r="1" fill="currentColor" stroke="none" />
            <circle cx="17" cy="21" r="1" fill="currentColor" stroke="none" />
          </svg>
          AgentDock
        </Link>
      )}
      {/* Logo — desktop only */}
      <Link to="/" className="header-title header-title-desktop">
        <svg className="header-logo" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <polyline points="6 8 10 12 6 16" />
          <line x1="14" y1="16" x2="18" y2="16" />
          <circle cx="7" cy="21" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="21" r="1" fill="currentColor" stroke="none" />
          <circle cx="17" cy="21" r="1" fill="currentColor" stroke="none" />
        </svg>
        AgentDock
      </Link>
      <nav className="header-nav header-nav-desktop">
        <button
          className="header-fix-me-btn"
          onClick={handleFixMe}
          disabled={fixingMe}
          title="Create a session to fix AgentDock"
        >
          {fixingMe ? "..." : "fix me"}
        </button>
        <button
          className="header-fix-me-btn"
          onClick={handleTalkToMe}
          disabled={talkingToMe}
          title="Open a general discussion session"
        >
          {talkingToMe ? "..." : "general chat"}
        </button>
        {quickLaunches.map((ql) => (
          <div key={ql.id} className="header-quick-launch">
            <button
              className="header-fix-me-btn"
              onClick={() => handleQuickLaunch(ql)}
              disabled={launchingId === ql.id}
              title={ql.targets.join(", ")}
            >
              {launchingId === ql.id ? "..." : ql.label}
            </button>
            <button
              className="header-quick-launch-remove"
              onClick={() => removeQuickLaunch(ql.id)}
              title="Remove from header"
            >&times;</button>
          </div>
        ))}
        {!isDemo() && (
          <button
            className="header-tour-btn"
            onClick={() => window.open("/?demo&tour=1", "_blank")}
            title="Interactive product tour"
          >
            ▶ tour
          </button>
        )}
        {!isDemo() && (
          <button
            className={`header-ngrok-btn ${ngrok.running ? "header-ngrok-btn-on" : ""}`}
            onClick={handleNgrokToggle}
            disabled={ngrokLoading}
            title={ngrok.running && ngrok.url ? `ngrok: ${ngrok.url}` : "Start ngrok tunnel"}
          >
            {ngrokLoading ? "..." : ngrok.running ? "ngrok on" : "Activate ngrok"}
          </button>
        )}
        <button
          className="settings-gear-btn"
          data-tutorial="settings-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
        >
          &#9881;
        </button>
        {authEnabled && (
          <button className="header-logout-btn" onClick={logout}>
            Logout
          </button>
        )}
      </nav>
      <div className="header-hamburger-wrap" ref={menuRef}>
        <button
          className="header-hamburger"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Menu"
        >
          {menuOpen ? "\u2715" : "\u2630"}
        </button>
        {menuOpen && (
          <div className="header-mobile-menu">
            <button
              className="header-fix-me-btn"
              onClick={() => { handleFixMe(); setMenuOpen(false); }}
              disabled={fixingMe}
            >
              {fixingMe ? "..." : "fix me"}
            </button>
            <button
              className="header-fix-me-btn"
              onClick={() => { handleTalkToMe(); setMenuOpen(false); }}
              disabled={talkingToMe}
            >
              {talkingToMe ? "..." : "general chat"}
            </button>
            {quickLaunches.map((ql) => (
              <button
                key={ql.id}
                className="header-fix-me-btn"
                onClick={() => { handleQuickLaunch(ql); setMenuOpen(false); }}
                disabled={launchingId === ql.id}
              >
                {launchingId === ql.id ? "..." : ql.label}
              </button>
            ))}
            <button
              className="settings-gear-btn"
              onClick={() => {
                setSettingsOpen(true);
                setMenuOpen(false);
              }}
            >
              &#9881; Settings
            </button>
            {!isDemo() && (
              <>
                <button
                  className={`header-ngrok-btn ${ngrok.running ? "header-ngrok-btn-on" : ""}`}
                  onClick={() => { handleNgrokToggle(); setMenuOpen(false); }}
                  disabled={ngrokLoading}
                >
                  {ngrokLoading ? "..." : ngrok.running ? "ngrok on" : "ngrok off"}
                </button>
                {ngrok.running && ngrok.url && (
                  <a
                    className="header-ngrok-url"
                    href={ngrok.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      e.preventDefault();
                      navigator.clipboard.writeText(ngrok.url!);
                    }}
                  >
                    {ngrok.url.replace("https://", "")}
                    <span className="header-ngrok-copy">⎘</span>
                  </a>
                )}
              </>
            )}
            {authEnabled && (
              <button
                className="header-logout-btn"
                onClick={() => { logout(); setMenuOpen(false); }}
              >
                Logout
              </button>
            )}
          </div>
        )}
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
    {ngrokToast && createPortal(
      <div className="ngrok-toast">
        <span className="ngrok-toast-label">ngrok ready</span>
        <a className="ngrok-toast-url" href={ngrokToast} target="_blank" rel="noopener noreferrer">
          {ngrokToast.replace("https://", "")}
        </a>
        <button className="ngrok-toast-copy" onClick={() => { navigator.clipboard.writeText(ngrokToast); }}>
          ⎘ copy
        </button>
        <button className="ngrok-toast-close" onClick={() => setNgrokToast(null)}>✕</button>
      </div>,
      document.body
    )}
    </>
  );
}
