import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Sparkles, Settings, LogOut, Menu, X } from "lucide-react";
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
      <Link to="/" className="header-title flex items-center gap-2">
        <div
          className="flex items-center justify-center rounded-lg"
          style={{ width: 24, height: 24, background: "var(--accent)" }}
        >
          <Sparkles size={14} color="var(--bg)" strokeWidth={2.5} />
        </div>
        <span>AgentDock</span>
      </Link>
      <nav className="header-nav header-nav-desktop">
        <button
          className="settings-gear-btn flex items-center gap-1"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
        >
          <Settings size={16} />
        </button>
        {authEnabled && (
          <button
            className="header-logout-btn flex items-center gap-1"
            onClick={logout}
          >
            <LogOut size={14} />
            <span>Logout</span>
          </button>
        )}
      </nav>
      <div className="header-hamburger-wrap" ref={menuRef}>
        <button
          className="header-hamburger"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Menu"
        >
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
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
              className="settings-gear-btn flex items-center gap-2"
              onClick={() => {
                setSettingsOpen(true);
                setMenuOpen(false);
              }}
            >
              <Settings size={16} /> Settings
            </button>
            {authEnabled && (
              <button
                className="header-logout-btn flex items-center gap-2"
                onClick={() => { logout(); setMenuOpen(false); }}
              >
                <LogOut size={14} /> Logout
              </button>
            )}
          </div>
        )}
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}
