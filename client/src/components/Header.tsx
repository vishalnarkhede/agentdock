import { useState, useRef, useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { SettingsModal } from "./SettingsModal";
import { createSession } from "../api";
import { useMobileNav } from "../MobileNavContext";
import { useAuth } from "../hooks/useAuth";
import type { Tab } from "../MobileNavContext";

const TABS: { id: Tab; label: string }[] = [
  { id: "terminal", label: "terminal" },
  { id: "plan", label: "plan" },
  { id: "changes", label: "changes" },
];

export function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fixingMe, setFixingMe] = useState(false);
  const [talkingToMe, setTalkingToMe] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mobileNav = useMobileNav();
  const { enabled: authEnabled, logout } = useAuth();

  const handleFixMe = async () => {
    if (fixingMe) return;
    setFixingMe(true);
    try {
      const { sessions } = await createSession({ targets: ["agentdock"], dangerouslySkipPermissions: true });
      if (sessions?.[0]) {
        navigate(`/?session=${sessions[0]}`);
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
      const { sessions } = await createSession({ targets: [], name: "talk", dangerouslySkipPermissions: true });
      if (sessions?.[0]) {
        navigate(`/?session=${sessions[0]}`);
      }
    } catch (err) {
      console.error("Failed to create talk session:", err);
    } finally {
      setTalkingToMe(false);
    }
  };

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
    <header className="header">
      {mobileNav?.inSession && (
        <button className="header-back-btn" onClick={mobileNav.goBack}>
          &lt; sessions
        </button>
      )}
      <Link to="/" className="header-title">
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
          {talkingToMe ? "..." : "talk to me"}
        </button>
        <button
          className="settings-gear-btn"
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
            {mobileNav?.inSession && (
              <div className="header-mobile-tabs">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    className={`header-mobile-tab ${mobileNav.activeTab === tab.id ? "header-mobile-tab-active" : ""}`}
                    onClick={() => {
                      mobileNav.setActiveTab(tab.id);
                      setMenuOpen(false);
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            )}
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
              {talkingToMe ? "..." : "talk to me"}
            </button>
            <button
              className="settings-gear-btn"
              onClick={() => {
                setSettingsOpen(true);
                setMenuOpen(false);
              }}
            >
              &#9881; Settings
            </button>
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
  );
}
