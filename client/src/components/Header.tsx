import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { SettingsModal } from "./SettingsModal";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mobileNav = useMobileNav();
  const { enabled: authEnabled, logout } = useAuth();

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
        Multi-Claude
      </Link>
      <nav className="header-nav header-nav-desktop">
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
