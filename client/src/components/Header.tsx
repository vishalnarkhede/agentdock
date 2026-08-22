import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { SettingsModal } from "./SettingsModal";
import { Icon } from "./Icon";
import { createSession, fetchPreferences, updatePreferences, fetchNgrokStatus, startNgrok, stopNgrok } from "../api";
import { useAuth } from "../hooks/useAuth";
import { isDemo } from "../demo";
import { useMobileNav } from "../MobileNavContext";
import { useSessions } from "../hooks/useSessions";
import { queueBucket } from "../queue";
import type { NgrokStatus } from "../api";
import "../styles/header-attention.css";

export interface QuickLaunch {
  id: string;
  label: string;
  sessionName?: string;
  targets: string[];
  agentType?: string;
}

export interface HeaderProps {
  onSelectSession?: (name: string) => void;
}

/** How many blocked sessions get a chip before the rest collapse to "+N". */
const MAX_CHIPS = 3;

/** Fired when the search affordance is used. The page that owns the session
 *  search listens for it — the header has no input of its own. */

/** Fired by the Next button. Dashboard owns the jump and the N key binding. */
export const QUEUE_NEXT_EVENT = "agentdock-queue-next";

export function Header({ onSelectSession }: HeaderProps = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const mobileNav = useMobileNav();
  const sessionTitle = mobileNav?.sessionTitle ?? "";
  const inSession = mobileNav?.inSession ?? false;
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fixingMe, setFixingMe] = useState(false);
  const [talkingToMe, setTalkingToMe] = useState(false);
  const [ngrok, setNgrok] = useState<NgrokStatus>({ running: false, url: null });
  const [ngrokLoading, setNgrokLoading] = useState(false);
  const [quickLaunches, setQuickLaunches] = useState<QuickLaunch[]>([]);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const { enabled: authEnabled, logout } = useAuth();

  // Reuses the app's polling hook rather than a private interval: the request
  // cost is identical either way, and the hook already stops polling while the
  // tab is hidden.
  const { sessions } = useSessions();

  // Top-level sessions only — a blocked sub-agent surfaces through its parent,
  // which is how the session list counts them too.
  const topLevel = useMemo(() => sessions.filter((s) => !s.parentSession), [sessions]);

  const counts = useMemo(() => {
    let blocked = 0, review = 0, working = 0;
    for (const s of topLevel) {
      const bucket = queueBucket(s);
      if (bucket === "blocked") blocked++;
      else if (bucket === "review") review++;
      else if (bucket === "working") working++;
    }
    return { blocked, review, working };
  }, [topLevel]);

  const summary = useMemo(() => {
    const parts: string[] = [];
    if (counts.blocked) parts.push(`${counts.blocked} waiting on you`);
    if (counts.review) parts.push(`${counts.review} to review`);
    if (counts.working) parts.push(`${counts.working} working`);
    return parts.length ? parts.join(" · ") : "Nothing waiting on you";
  }, [counts]);

  const blockedSessions = useMemo(
    () => topLevel.filter((s) => queueBucket(s) === "blocked"),
    [topLevel],
  );

  const selectSession = useCallback((name: string) => {
    if (onSelectSession) onSelectSession(name);
    else navigate(`/?session=${encodeURIComponent(name)}`);
  }, [onSelectSession, navigate]);

  // Walking the queue in cost order belongs to whoever owns the session
  // selection, so the button only announces the intent. The same event backs
  // the N key binding.
  const goNext = useCallback(() => {
    window.dispatchEvent(new Event(QUEUE_NEXT_EVENT));
  }, []);

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
      const { sessions } = await createSession({ targets: ["__agentdock__"], dangerouslySkipPermissions: true });
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

  // Close the launch-actions menu on outside click or Escape
  useEffect(() => {
    if (!moreOpen) return;
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMoreOpen(false);
    }
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [moreOpen]);

  // Close menus on route change
  useEffect(() => {
    setMenuOpen(false);
    setMoreOpen(false);
  }, [location.pathname]);

  return (
    <>
    <header className="header header-attn">
      {/* Back button — mobile only, non-root pages or when in session */}
      {(location.pathname !== "/" || inSession) && (
        <button
          className="header-back-btn header-back-btn-mobile"
          onClick={() => inSession ? mobileNav?.goBack() : navigate(-1)}
          aria-label="Back"
        >
          <Icon name="chevl" size={20} />
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
      {/* Attention summary — what the queue costs right now */}
      <div className="hdr-attn">
        <span className="hdr-attn-summary">{summary}</span>
        {blockedSessions.length > 0 && (
          <div className="hdr-attn-chips">
            {blockedSessions.slice(0, MAX_CHIPS).map((s) => (
              <button
                key={s.name}
                className="hdr-chip"
                onClick={() => selectSession(s.name)}
                title={`${s.displayName} is waiting on you`}
              >
                <span className="hdr-chip-dot" />
                <span className="hdr-chip-name">{s.displayName}</span>
              </button>
            ))}
            {blockedSessions.length > MAX_CHIPS && (
              <span className="hdr-chip-more">+{blockedSessions.length - MAX_CHIPS}</span>
            )}
          </div>
        )}
        {topLevel.length > 0 && (
          <button className="hdr-next" onClick={goNext} title="Jump to the next session by cost (N)">
            <span>Next</span>
            <Icon name="chevr" size={12} />
            <span className="hdr-keycap">N</span>
          </button>
        )}
      </div>
      <nav className="header-nav header-nav-desktop">
        {/* The launch actions collapse into one control. Inline they run to
            ~500px with a few quick launches configured, which starves the
            attention line the bar exists for. */}
        <div className="hdr-more-wrap" ref={moreRef}>
          <button
            className={`hdr-more ${ngrok.running ? "hdr-more-live" : ""}`}
            onClick={() => setMoreOpen(!moreOpen)}
            aria-label="Launch actions"
            aria-expanded={moreOpen}
            title={ngrok.running && ngrok.url ? `Launch actions — ngrok: ${ngrok.url}` : "Launch actions"}
          >
            <Icon name="more" size={16} />
          </button>
          {moreOpen && (
            <div className="hdr-more-menu">
              <button
                className="header-fix-me-btn"
                onClick={() => { handleFixMe(); setMoreOpen(false); }}
                disabled={fixingMe}
                title="Create a session to fix AgentDock"
              >
                {fixingMe ? "..." : "fix me"}
              </button>
              <button
                className="header-fix-me-btn"
                onClick={() => { handleTalkToMe(); setMoreOpen(false); }}
                disabled={talkingToMe}
                title="Open a general discussion session"
              >
                {talkingToMe ? "..." : "general chat"}
              </button>
              {quickLaunches.map((ql) => (
                <div key={ql.id} className="header-quick-launch">
                  <button
                    className="header-fix-me-btn"
                    onClick={() => { handleQuickLaunch(ql); setMoreOpen(false); }}
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
                  onClick={() => { window.open("/?demo&tour=1", "_blank"); setMoreOpen(false); }}
                  title="Interactive product tour"
                >
                  <Icon name="play" size={12} /> tour
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
                  <span className="header-ngrok-copy"><Icon name="copy" size={12} /></span>
                </a>
              )}
            </div>
          )}
        </div>
        <button className="hdr-new" onClick={() => navigate("/create")}>
          <Icon name="plus" size={15} />
          New
        </button>
        <button
          className="settings-gear-btn"
          data-tutorial="settings-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
        >
          <Icon name="gear" size={17} />
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
          <Icon name={menuOpen ? "close" : "layers"} size={18} />
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
              <Icon name="gear" size={16} /> Settings
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
                    <span className="header-ngrok-copy"><Icon name="copy" size={12} /></span>
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
          <Icon name="copy" size={12} /> copy
        </button>
        <button className="ngrok-toast-close" onClick={() => setNgrokToast(null)}><Icon name="close" size={13} /></button>
      </div>,
      document.body
    )}
    </>
  );
}
