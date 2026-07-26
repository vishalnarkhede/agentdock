import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { SettingsModal } from "./SettingsModal";
import { createSession } from "../api";
import { useAuth } from "../hooks/useAuth";
import { isDemo } from "../demo";
import { useMobileNav } from "../MobileNavContext";
import { ShareLinkButton } from "./ShareLink";

export function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const mobileNav = useMobileNav();
  const sessionTitle = mobileNav?.sessionTitle ?? "";
  const inSession = mobileNav?.inSession ?? false;
  const [menuOpen, setMenuOpen] = useState(false);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fixingMe, setFixingMe] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const appMenuRef = useRef<HTMLDivElement>(null);
  const { enabled: authEnabled, logout } = useAuth();

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

  // Tutorial: open settings modal on request
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener("agentdock-tutorial-open-settings", handler);
    return () => window.removeEventListener("agentdock-tutorial-open-settings", handler);
  }, []);

  // Tutorial: re-open the app menu so the step highlighting "Settings" has a target
  // even if an overlay click closed it.
  useEffect(() => {
    const handler = () => setAppMenuOpen(true);
    window.addEventListener("agentdock-tutorial-open-menu", handler);
    return () => window.removeEventListener("agentdock-tutorial-open-menu", handler);
  }, []);

  // Close menus on outside click
  useEffect(() => {
    if (!menuOpen && !appMenuOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false);
      }
      if (appMenuRef.current && !appMenuRef.current.contains(target)) {
        setAppMenuOpen(false);
      }
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menuOpen, appMenuOpen]);

  // Close menu on route change
  useEffect(() => {
    setMenuOpen(false);
    setAppMenuOpen(false);
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
        {!isDemo() && <ShareLinkButton variant="desktop" />}
        {/* One menu for every app-level action. Mirrors the mobile hamburger, which
            already grouped these — desktop was the outlier with four controls. */}
        <div className="header-help-wrap" ref={appMenuRef}>
          <button
            className="header-menu-btn"
            data-tutorial="menu-btn"
            onClick={() => setAppMenuOpen((open) => !open)}
            aria-label="Menu"
            aria-expanded={appMenuOpen}
            aria-haspopup="menu"
            title="Menu"
          >
            &#8943;
          </button>
          {appMenuOpen && (
            <div className="header-help-menu" role="menu">
              <button
                className="header-help-menu-item"
                role="menuitem"
                onClick={() => { handleFixMe(); setAppMenuOpen(false); }}
                disabled={fixingMe}
              >
                {fixingMe ? "..." : "Fix AgentDock"}
              </button>
              {!isDemo() && (
                <button
                  className="header-help-menu-item"
                  role="menuitem"
                  onClick={() => { window.open("/?demo&tour=1", "_blank"); setAppMenuOpen(false); }}
                >
                  Tour
                </button>
              )}
              <div className="header-menu-divider" />
              <button
                className="header-help-menu-item"
                role="menuitem"
                data-tutorial="settings-menu-item"
                onClick={() => { setSettingsOpen(true); setAppMenuOpen(false); }}
              >
                Settings
              </button>
              {authEnabled && (
                <button
                  className="header-help-menu-item"
                  role="menuitem"
                  onClick={() => { logout(); setAppMenuOpen(false); }}
                >
                  Logout
                </button>
              )}
            </div>
          )}
        </div>
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
              {fixingMe ? "..." : "Fix AgentDock"}
            </button>
            {!isDemo() && (
              <button
                className="header-fix-me-btn"
                onClick={() => { window.open("/?demo&tour=1", "_blank"); setMenuOpen(false); }}
              >
                Tour
              </button>
            )}
            <button
              className="settings-gear-btn"
              onClick={() => {
                setSettingsOpen(true);
                setMenuOpen(false);
              }}
            >
              &#9881; Settings
            </button>
            {!isDemo() && <ShareLinkButton variant="mobile" />}
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
    </>
  );
}
