import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { MetaSelect } from "../components/MetaSelect";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSessions } from "../hooks/useSessions";
import { deleteSession, deleteAllSessions, openInIterm, reorderSessions, fetchSettingsStatus, updateBasePath, scanRepos, addSettingsRepo, sendSessionInput, fetchGitRepos, fetchPreferences, updatePreferences, fetchMetaPropertyPresets, saveMetaPropertyPresets, updateSessionMeta, renameSession, restoreSession, createSession, fetchSettingsHealth, setPassword } from "../api";
import { isDemo } from "../demo";
import { TutorialOverlay } from "../components/TutorialOverlay";
import { Icon, type IconName } from "../components/Icon";
import { fetchHookState, installHooks, type HookState } from "../api";
import { PlanView } from "../components/PlanView";
import "../styles/sidebar-header.css";
import { QUEUE_BUCKETS, queueBucket } from "../queue";
import { fetchConflicts, fetchPanelSummary, fetchShells, openShell, closeShell } from "../api";
import { QuietView } from "../components/QuietView";
import { MobileQueue } from "../components/MobileQueue";
import { MobileApprove } from "../components/MobileApprove";
import { useQueueNotifications } from "../hooks/useQueueNotifications";
import { useSettings } from "../hooks/useSettings";
import { TerminalView } from "../components/TerminalView";
import { ChangesView } from "../components/ChangesView";
import { SubAgentsView } from "../components/SubAgentsView";
import { WorktreesView } from "../components/WorktreesView";
import { FileExplorer } from "../components/FileExplorer";
import type { FileExplorerHandle } from "../components/FileExplorer";
import { useMobileNav } from "../MobileNavContext";
import { useAuth } from "../hooks/useAuth";
import type { SessionInfo, MetaPropertyPreset } from "../types";
import type { QuickLaunch } from "../components/Header";

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

const ASCII_LOGO = `
 ┌─┐┌─┐┌─┐┌┐┌┌┬┐┌┬┐┌─┐┌─┐┬┌─
 ├─┤│ ┬├┤ │││ │  │││ │ │  ├┴┐
 ┴ ┴└─┘└─┘┘└┘ ┴ ─┴┘└─┘└─┘┴ ┴
`;

function getDemoTutorialAttr(session: SessionInfo): string | undefined {
  if (!isDemo()) return undefined;
  if (session.name === "acme-api-auth-fix") return "session-auth-fix";
  if (session.status === "working" && session.name === "acme-api-auth-fix") return "session-working";
  if (session.name === "acme-api-rate-limiter") return "session-done";
  if (session.name === "infra-k8s-migration/api-routes") return "session-input";
  if (session.name === "infra-k8s-migration") return "session-subagents";
  if (session.status === "stopped") return "session-stopped";
  if (session.status === "working") return "session-working";
  return undefined;
}

function getDisplayStatus(session: SessionInfo): string {
  if (session.status === "stopped") return "stopped";
  return session.statusLine?.type
    ?? (session.status === "shell" ? "done" : session.status === "unknown" ? "" : session.status);
}

const FULL_SURFACES = ["plan", "changes", "files", "sub-agents", "worktrees"] as const;
type FullSurface = (typeof FULL_SURFACES)[number];

/** Surfaces reachable from the full-window host's own tab bar. */
const FULL_TABS: { id: FullSurface; label: string }[] = [
  { id: "plan", label: "plan" },
  { id: "changes", label: "changes" },
  { id: "files", label: "files" },
];

/** Blocked means the agent cannot continue without a human. */
function isBlocked(session: SessionInfo): boolean {
  return queueBucket(session) === "blocked";
}

/**
 * The right rail: icons only, always present, never moving. Pressing one opens
 * that surface fully expanded over the window — the surfaces are drawn
 * standalone in the design, so a docked panel was always the wrong container.
 */
const RAIL: { id: FullSurface; label: string; icon: IconName }[] = [
  { id: "plan", label: "Plan", icon: "plan" },
  { id: "changes", label: "Changes", icon: "diff" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "sub-agents", label: "Sub-agents", icon: "users" },
];

function SessionRow({
  session,
  active,
  onSelect,
  onStopped,
  isChild,
  isLastChild,
  childrenSummary,
  childrenExpanded,
  onToggleChildren,
  pinned,
  onTogglePin,
  draggable,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  isDragging,
  isDragOver,
  onEditProps,
  onPinToHeader,
  onRestore,
  onForkSession,
  dataTutorial,
  selectionMode,
  selected,
  onToggleSelect,
}: {
  session: SessionInfo;
  active: boolean;
  onSelect: () => void;
  onStopped: () => void;
  isChild?: boolean;
  isLastChild?: boolean;
  childrenSummary?: { total: number; working: number; done: number; error: number };
  childrenExpanded?: boolean;
  onToggleChildren?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  onEditProps?: () => void;
  onPinToHeader?: () => void;
  onRestore?: () => Promise<void>;
  onForkSession?: () => void;
  dataTutorial?: string;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      const t = e.target as Node;
      // Same portal caveat as SidebarMenu: the menu no longer lives inside the
      // wrap that menuRef points at.
      if (menuRef.current?.contains(t) || rowMenuRef.current?.contains(t)) return;
      setMenuOpen(false);
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menuOpen]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(session.name);
    setMenuOpen(false);
  };

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    const path = session.worktrees?.[0]?.wtDir || session.path;
    navigator.clipboard.writeText(path);
    setMenuOpen(false);
  };

  const handleOpenIterm = (e: React.MouseEvent) => {
    e.stopPropagation();
    openInIterm(session.name);
    setMenuOpen(false);
  };

  const handleEditProps = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onEditProps?.();
  };

  const handleKill = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Kill session "${session.displayName}"?`)) return;
    setMenuOpen(false);
    try {
      await deleteSession(session.name);
      onStopped();
    } catch (err: any) {
      console.error("Failed to delete session:", err);
    }
  };

  const handleRestore = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    setRestoring(true);
    try {
      await onRestore?.();
    } catch (err: any) {
      console.error("Failed to restore session:", err);
    } finally {
      setRestoring(false);
    }
  };

  const displayStatus = getDisplayStatus(session);
  const displayPath = session.worktrees?.[0]?.wtDir || session.path;

  return (
    <div
      className={`session-row ${active && !selectionMode ? "session-row-active" : ""} ${selected ? "session-row-selected" : ""} ${isChild ? "session-row-child" : ""} ${isChild && isLastChild ? "session-row-child-last" : ""} ${isDragging ? "dragging" : ""} ${isDragOver ? "drag-over" : ""} ${session.status === "stopped" ? "session-row-stopped" : ""}`}
      data-tutorial={dataTutorial}
      onClick={selectionMode ? (e) => { e.stopPropagation(); onToggleSelect?.(); } : onSelect}
      draggable={selectionMode ? false : draggable}
      onDragStart={selectionMode ? undefined : onDragStart}
      onDragOver={selectionMode ? undefined : onDragOver}
      onDragEnd={selectionMode ? undefined : onDragEnd}
      onDrop={selectionMode ? undefined : onDrop}
    >
      <div className="session-row-main">
        {selectionMode && (
          <span className={`session-row-select-check${selected ? " session-row-select-check-on" : ""}`} />
        )}
        {isChild && (
          <span className="session-row-tree-connector">
            {isLastChild ? "\u2514\u2500" : "\u251C\u2500"}
          </span>
        )}
        <span className={`session-row-dot status-${displayStatus || session.status}`} />
        {pinned && <span className="session-row-pin" title="Pinned">&#x25C6;</span>}
        <span className="session-row-name">
          {session.displayName}
        </span>
        {session.sessionType && (
          <span className={`session-row-type-badge ${session.sessionType}`}>
            {session.sessionType === "fix-comments" ? "fix comments" :
             session.sessionType === "review-pr" ? "review" :
             session.sessionType === "fix-ci" ? "fix ci" :
             session.sessionType}
          </span>
        )}
        {childrenSummary && childrenSummary.total > 0 && (
          <button
            className="session-row-children-badge"
            onClick={(e) => { e.stopPropagation(); onToggleChildren?.(); }}
            title={`${childrenSummary.total} sub-agent${childrenSummary.total !== 1 ? "s" : ""}`}
          >
            <span className="children-badge-icon"><Icon name={childrenExpanded ? "chev" : "chevr"} size={11} /></span>
            <span className="children-badge-count">{childrenSummary.total}</span>
            {childrenSummary.working > 0 && (
              <span className="children-badge-dot children-badge-working" title={`${childrenSummary.working} working`} />
            )}
            {childrenSummary.done > 0 && (
              <span className="children-badge-dot children-badge-done" title={`${childrenSummary.done} done`} />
            )}
            {childrenSummary.error > 0 && (
              <span className="children-badge-dot children-badge-error" title={`${childrenSummary.error} error`} />
            )}
          </button>
        )}
        {displayStatus && displayStatus !== "stopped" && (
          <span className={`session-row-status status-${displayStatus}`}>
            {displayStatus}
          </span>
        )}
        {session.status === "stopped" && onRestore && (
          <button
            className={`session-row-restore-btn ${restoring ? "restoring" : ""}`}
            onClick={handleRestore}
            disabled={restoring}
            title="Restore session"
          >
            {restoring ? "restoring…" : <><Icon name="refresh" size={11} /> restore</>}
          </button>
        )}
        {session.status !== "stopped" && (
          <span className="session-row-age">{timeAgo(session.created)}</span>
        )}
      </div>
      {session.statusLine && (
        <div className={`session-row-statusline status-${session.statusLine.type}`}>
          {session.statusLine.message}
        </div>
      )}
      <div className="session-row-meta">
        <span className="session-row-path" title={displayPath}>
          {displayPath.replace(/^\/Users\/[^/]+\//, "~/")}
        </span>
        {session.agentType && session.agentType !== "claude" && (
          <span className="session-row-agent" title={`Agent: ${session.agentType}`}>
            {session.agentType === "cursor" ? "Cursor" : session.agentType}
          </span>
        )}
        {session.meta && Object.keys(session.meta).length > 0 && (
          <span className="session-row-meta-tags">
            {Object.entries(session.meta).map(([k, v]) => (
              <span key={k} className="session-row-meta-tag" title={k}>{v}</span>
            ))}
          </span>
        )}
        {!selectionMode && <div className="session-row-menu-wrap" ref={menuRef}>
          <button
            className="session-row-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              // .session-list scrolls, so an absolutely positioned menu is
              // clipped by it — worst at the bottom of the list, which is
              // exactly where stopped sessions sit.
              const r = e.currentTarget.getBoundingClientRect();
              const MENU_H = 260;
              setMenuPos({
                top: r.bottom + MENU_H > window.innerHeight ? r.top - MENU_H : r.bottom + 4,
                right: Math.max(8, window.innerWidth - r.right),
              });
              setMenuOpen(!menuOpen);
            }}
            aria-label="Session actions"
          >
            <Icon name="more" size={16} />
          </button>
          {menuOpen && menuPos && createPortal(
            <div ref={rowMenuRef} className="session-row-menu" style={{ top: menuPos.top, right: menuPos.right }}>
              {onTogglePin && (
                <button className="session-row-menu-item" onClick={(e) => { e.stopPropagation(); onTogglePin(); setMenuOpen(false); }}>
                  {pinned ? "Unpin" : "Pin to top"}
                </button>
              )}
              {onEditProps && (
                <button className="session-row-menu-item" onClick={handleEditProps}>Edit properties</button>
              )}
              {onPinToHeader && (
                <button className="session-row-menu-item" onClick={(e) => { e.stopPropagation(); onPinToHeader(); setMenuOpen(false); }}>Pin to header</button>
              )}
              {onForkSession && (
                <button className="session-row-menu-item" onClick={(e) => { e.stopPropagation(); onForkSession(); setMenuOpen(false); }}>
                  + New agent here
                </button>
              )}
              <button className="session-row-menu-item" onClick={handleCopy}>Copy name</button>
              <button className="session-row-menu-item" onClick={handleCopyPath}>Copy path</button>
              {session.status !== "stopped" && (
                <button className="session-row-menu-item" onClick={handleOpenIterm}>Open in iTerm</button>
              )}
              {session.status === "stopped" && onRestore && (
                <button className="session-row-menu-item" onClick={handleRestore} disabled={restoring}>
                  {restoring ? "Restoring…" : <><Icon name="refresh" size={13} /> Restore session</>}
                </button>
              )}
              <button className="session-row-menu-item danger" onClick={handleKill}>
                {session.status === "stopped" ? "Delete" : "Kill session"}
              </button>
            </div>,
            document.body,
          )}
        </div>}
      </div>
    </div>
  );
}


function SessionEditModal({
  session,
  presets,
  onSave,
  onClose,
}: {
  session: SessionInfo;
  presets: MetaPropertyPreset[];
  onSave: (meta: Record<string, string>, updatedPresets: MetaPropertyPreset[], newDisplayName: string) => Promise<void>;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<Record<string, string>>(session.meta || {});
  const [name, setName] = useState(session.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name cannot be empty");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(meta, presets, name.trim());
    } catch (err: any) {
      setError(err?.message || "Failed to save");
      setSaving(false);
    }
  };

  return createPortal(
    <div className="settings-overlay" onClick={onClose}>
      <div className="session-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">{session.displayName}</span>
          <button className="settings-close-btn" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="session-edit-body">
          <div className="session-edit-field">
            <label className="session-edit-label">Name</label>
            <input
              type="text"
              className="form-input"
              placeholder="Session name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              autoFocus
            />
          </div>
          {presets.map((preset) => (
            <div key={preset.key} className="session-edit-field">
              <label className="session-edit-label">{preset.label}</label>
              {preset.values.length > 0 ? (
                <MetaSelect
                  values={preset.values}
                  value={meta[preset.key] || ""}
                  onChange={(v) => setMeta(prev => ({ ...prev, [preset.key]: v }))}
                  onAddNew={(v) => {
                    preset.values.push(v);
                    setMeta(prev => ({ ...prev, [preset.key]: v }));
                  }}
                  placeholder="—"
                />
              ) : (
                <input
                  type="text"
                  className="form-input"
                  placeholder={preset.label}
                  value={meta[preset.key] || ""}
                  onChange={(e) => setMeta(prev => ({ ...prev, [preset.key]: e.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
        {error && <div className="session-edit-error">{error}</div>}
        <div className="session-edit-footer">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
          <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Rare and destructive sidebar actions. Kill-all was previously the largest,
 * loudest control in the sidebar; here it takes a deliberate second step and
 * sits below a separator.
 */
function SidebarMenu({
  canSelect,
  canKillAll,
  onSelect,
  onKillAll,
  groupAction,
}: {
  canSelect: boolean;
  canKillAll: boolean;
  onSelect: () => void;
  onKillAll: () => void;
  groupAction?: { label: string; run: () => void };
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu is portalled to <body>, so it is not inside btnRef. Without
      // checking it too, mousedown on an item closed the menu before the click
      // could reach the item's handler — every option looked inert.
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect();
    // Fixed + portal: the sidebar scrolls and clips, so an absolute menu here
    // would be cut off.
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    setOpen((v) => !v);
  };

  if (!canSelect && !canKillAll && !groupAction) return null;

  return (
    <>
      <button
        ref={btnRef}
        className={`sidebar-iconbtn${open ? " sidebar-iconbtn-on" : ""}`}
        onClick={toggle}
        title="More actions"
        aria-label="More actions"
        aria-expanded={open}
      >
        &#8943;
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="sidebar-menu" style={{ top: pos.top, right: pos.right }} role="menu">
          {groupAction && (
            <button className="sidebar-menu-item" role="menuitem" onClick={() => { setOpen(false); groupAction.run(); }}>
              {groupAction.label}
            </button>
          )}
          {canSelect && (
            <button className="sidebar-menu-item" role="menuitem" onClick={() => { setOpen(false); onSelect(); }}>
              Select multiple…
            </button>
          )}
          {canSelect && canKillAll && <div className="sidebar-menu-sep" />}
          {canKillAll && (
            <button className="sidebar-menu-item danger" role="menuitem" onClick={() => { setOpen(false); onKillAll(); }}>
              Kill all sessions
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

export function Dashboard() {
  const { sessions, loading, refresh } = useSessions();
  const { settings: appSettings } = useSettings();
  const { login: authLogin } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mobileNav = useMobileNav();
  const [mobileShowTerminal, setMobileShowTerminal] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const activeTab = mobileNav?.activeTab ?? "terminal";
  const setActiveTab = mobileNav?.setActiveTab ?? (() => {});

  // Bottom pane (plan/changes/sub-agents) split with terminal
  const [bottomTab, setBottomTab] = useState<"plan" | "changes" | "sub-agents" | "files" | null>(null);
  // Desktop uses the accordion; the design opens Plan and Changes by default.
  const [openPanels, setOpenPanels] = useState<Set<string>>(() => new Set(["plan", "changes"]));
  // Review is a full-window mode in the design, not a panel — review quality
  // falls off when it is cramped, which is the whole reason it takes over.
  /**
   * The design draws every context surface standalone — filling the frame with
   * no cockpit around it. The accordion carries a summary and an "open"
   * affordance; the surface itself takes the window.
   */
  const [sharedWith, setSharedWith] = useState<{ session: string; files: number } | null>(null);
  const [mobileApproveDismissed, setMobileApproveDismissed] = useState(false);
  /* Plain shells in the same worktree, beside the agent. Two at most: past that
     the panes are too small to run anything in. */
  const [shells, setShells] = useState<string[]>([]);
  const [shellBusy, setShellBusy] = useState(false);
  const [panelSummary, setPanelSummary] = useState<{
    planDone: number; planTotal: number; plus: number; minus: number; fileCount: number;
  } | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.5); // 0..1, fraction for terminal
  const [bottomMaximized, setBottomMaximized] = useState(false);
  const [planViewMode, setPlanViewMode] = useState<"rendered" | "raw">("rendered");
  const [planMenuOpen, setPlanMenuOpen] = useState(false);
  const planMenuRef = useRef<HTMLDivElement>(null);
  const splitDragging = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDragging.current = true;
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!splitDragging.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      setSplitRatio(Math.max(0.2, Math.min(0.8, ratio)));
      // Tell terminal to refit during drag
      window.dispatchEvent(new Event("resize"));
    };
    const onMouseUp = () => { splitDragging.current = false; };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Reset maximized when closing bottom pane
  useEffect(() => {
    if (!bottomTab) setBottomMaximized(false);
  }, [bottomTab]);

  // Close plan menu on click outside
  useEffect(() => {
    if (!planMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (planMenuRef.current && !planMenuRef.current.contains(e.target as Node)) {
        setPlanMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [planMenuOpen]);

  // Refit terminal when bottom pane opens/closes or maximize toggles
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
    return () => clearTimeout(t);
  }, [bottomTab, bottomMaximized]);

  // First-run setup
  const [showSetup, setShowSetup] = useState(false);
  const [setupStep, setSetupStep] = useState<"path" | "repos" | "hooks" | "password">("path");
  const [setupHooks, setSetupHooks] = useState<HookState | null>(null);
  const [setupHooksBusy, setSetupHooksBusy] = useState(false);
  const [setupPath, setSetupPath] = useState("~/projects");
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [discoveredRepos, setDiscoveredRepos] = useState<{ alias: string; path: string; remote?: string; selected: boolean }[]>([]);
  const [setupPassword, setSetupPassword] = useState("");
  const [setupAccess, setSetupAccess] = useState<"local" | "network">("network");
  const [setupPasswordConfirm, setSetupPasswordConfirm] = useState("");

  const [missingTools, setMissingTools] = useState<string[]>([]);
  const [missingToolsDismissed, setMissingToolsDismissed] = useState(false);

  useEffect(() => {
    fetchSettingsStatus().then((status) => {
      if (status.needsSetup) {
        setSetupPath(status.basePath);
        setShowSetup(true);
      }
    }).catch(() => {});
    fetchSettingsHealth().then((h) => {
      const required = [
        { name: "tmux", ok: h.tmux.installed },
        { name: "claude", ok: h.claude.installed },
        { name: "git", ok: h.git.installed },
        { name: "bun", ok: h.bun.installed },
      ];
      const missing = required.filter((t) => !t.ok).map((t) => t.name);
      if (missing.length > 0) setMissingTools(missing);
    }).catch(() => {});
  }, []);

  const handleSetupScanRepos = async () => {
    setSetupSaving(true);
    setSetupError(null);
    try {
      await updateBasePath(setupPath);
      const repos = await scanRepos();
      if (repos.length > 0) {
        setDiscoveredRepos(repos.map((r) => ({ ...r, selected: true })));
        setSetupStep("repos");
      } else {
        setSetupStep("hooks");
      }
    } catch (err: any) {
      setSetupError(err?.message || "Failed to scan repos");
    } finally {
      setSetupSaving(false);
    }
  };

  const handleSetupFinish = async () => {
    setSetupSaving(true);
    setSetupError(null);
    try {
      const selected = discoveredRepos.filter((r) => r.selected);
      await Promise.all(selected.map((r) => addSettingsRepo({ alias: r.alias, path: r.path, remote: r.remote })));
      setSetupStep("hooks");
    } catch (err: any) {
      setSetupError(err?.message || "Failed to save repos");
    } finally {
      setSetupSaving(false);
    }
  };

  const handleSetupSetPassword = async () => {
    if (setupPassword !== setupPasswordConfirm) {
      setSetupError("Passwords do not match");
      return;
    }
    setSetupSaving(true);
    setSetupError(null);
    try {
      const result = await setPassword(setupPassword);
      if (result.error) throw new Error(result.error);
      // Auto-login so user isn't immediately redirected to the login page
      await authLogin(setupPassword);
      setShowSetup(false);
    } catch (err: any) {
      setSetupError(err?.message || "Failed to set password");
    } finally {
      setSetupSaving(false);
    }
  };

  const toolbarRef = useRef<HTMLDivElement>(null);
  const activeSession = searchParams.get("session");

  /**
   * Session and open surface both live in the URL, so a refresh lands you back
   * where you were. Each setter preserves the other key — the previous
   * implementation replaced the whole param set, so switching session silently
   * dropped whatever surface was open.
   */
  const setActiveSession = useCallback((name: string | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (name) next.set("session", name);
      else next.delete("session");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const rawView = searchParams.get("view");
  const fullSurface: FullSurface | null =
    rawView && (FULL_SURFACES as readonly string[]).includes(rawView)
      ? (rawView as FullSurface)
      : null;

  const setFullSurface = useCallback((id: FullSurface | null) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("view", id);
      else next.delete("view");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  /**
   * Opening a session from inside a surface: one URL write, not two.
   *
   * setActiveSession and setFullSurface both call setSearchParams, and its
   * functional form reads the params from the last committed render rather than
   * from a queued update — so calling them in the same handler makes the second
   * overwrite the first. The surface closed and the session did not change,
   * which is what jumping from Sub-agents did too.
   */
  const jumpToSession = useCallback((name: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("session", name);
      next.delete("view");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  /**
   * A phone renders surfaces through bottomTab; fullSurface is desktop only.
   * A ?view= link shared from a desktop would otherwise leave the main area
   * blank, so translate it once on arrival.
   */
  useEffect(() => {
    if (!isMobile || !fullSurface) return;
    setBottomTab(fullSurface as typeof bottomTab);
    setBottomMaximized(true);
    setMobileShowTerminal(true);
    setFullSurface(null);
  }, [isMobile, fullSurface, setFullSurface]);

  // Tour mode: active when ?tour=1 is in the URL (demo mode only)
  const [tourActive, setTourActive] = useState(() =>
    isDemo() && new URLSearchParams(window.location.search).has("tour")
  );

  // Track which parent session groups are expanded/collapsed
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  const toggleParentCollapse = useCallback((parentName: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parentName)) next.delete(parentName);
      else next.add(parentName);
      return next;
    });
  }, []);

  // Drag-and-drop state for reordering parent sessions
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<string>("__queue__");
  const [sortBy, setSortBy] = useState<string>("");
  const [sessionStats, setSessionStats] = useState<Record<string, { count: number; last: number }>>({});
  const sessionStatsRef = useRef<Record<string, { count: number; last: number }>>({});
  const statsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Frozen display order for the "recently used" sort. Recency is recorded in
  // sessionStats on every click, but this ordering only changes at non-disruptive
  // moments (load, session add/remove, and after you settle on a session) so the
  // list does not reshuffle each time you click through sessions.
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [recentOrder, setRecentOrder] = useState<string[]>([]);
  const recentInitedRef = useRef(false);
  const recentSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionNamesRef = useRef<string[]>([]);
  const RECENT_SETTLE_MS = 8000;
  const sortNamesByRecency = useCallback((names: string[], prevOrder: string[]): string[] => {
    const prevIdx = new Map(prevOrder.map((n, i) => [n, i]));
    return [...names].sort((a, b) => {
      const la = sessionStatsRef.current[a]?.last ?? 0;
      const lb = sessionStatsRef.current[b]?.last ?? 0;
      if (lb !== la) return lb - la;
      // Stable tie-break: keep prior frozen position, then name — never depends on
      // the volatile server/tmux order, so equal-recency rows don't shuffle on poll.
      const pa = prevIdx.get(a) ?? Number.MAX_SAFE_INTEGER;
      const pb = prevIdx.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });
  }, []);
  const [metaPresets, setMetaPresets] = useState<MetaPropertyPreset[]>([]);
  const [editingSession, setEditingSession] = useState<SessionInfo | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      updatePreferences({ collapsedGroups: [...next] });
      return next;
    });
  }, []);

  useEffect(() => {
    fetchPreferences().then((p) => {
      if (p.pinnedSessions) setPinnedSessions(new Set(p.pinnedSessions));
      // Sort and grouping are mutually exclusive; a saved sort takes precedence.
      if (p.sortBy) setSortBy(p.sortBy);
      else if (p.groupBy) setGroupBy(p.groupBy);
      else if (!p.sortBy) setGroupBy("__queue__");
      if (p.collapsedGroups) setCollapsedGroups(new Set(p.collapsedGroups));
      if (p.mruSessions) mruList.current = p.mruSessions;
      if (p.sessionStats) {
        sessionStatsRef.current = p.sessionStats;
        setSessionStats(p.sessionStats);
      }
      setPrefsLoaded(true);
    }).catch(() => setPrefsLoaded(true));
    fetchMetaPropertyPresets().then(setMetaPresets);
    const handler = () => fetchMetaPropertyPresets().then(setMetaPresets);
    window.addEventListener("agentdock-meta-presets-changed", handler);
    return () => window.removeEventListener("agentdock-meta-presets-changed", handler);
  }, []);

  const togglePin = useCallback((name: string) => {
    setPinnedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      updatePreferences({ pinnedSessions: [...next] });
      return next;
    });
  }, []);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const sessionSearchRef = useRef<HTMLInputElement>(null);

  // Cmd+K to focus session search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        sessionSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Cmd+P to open file explorer and focus search
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setBottomTab("files");
        setBottomMaximized(false);
        setTimeout(() => fileExplorerRef.current?.focusSearch(), 50);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Escape to collapse bottom pane (when focus is not in an input/textarea)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      setBottomTab((prev) => (prev ? null : prev));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ─── MRU session switching ───
  // mruList[0] = most recently visited, mruList[1] = previous, etc.
  const mruList = useRef<string[]>([]);
  const [mruSwitcherVisible, setMruSwitcherVisible] = useState(false);
  const mruDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mruSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flag: when navigating via shortcut, don't reorder the list (would cause flip-flop)
  const mruNavigating = useRef(false);

  // Update MRU order when active session changes — but NOT during shortcut navigation
  useEffect(() => {
    if (!activeSession) return;
    if (mruNavigating.current) return;
    mruList.current = [
      activeSession,
      ...mruList.current.filter((s) => s !== activeSession),
    ].slice(0, 8);
    if (mruSaveTimer.current) clearTimeout(mruSaveTimer.current);
    mruSaveTimer.current = setTimeout(() => {
      updatePreferences({ mruSessions: mruList.current });
    }, 1000);

    // Usage stats drive the "recently/frequently used" sort. They change ONLY
    // here (on a deliberate session switch), never on the status poll, so the
    // sorted list stays stable between navigations instead of flickering.
    const cur = sessionStatsRef.current[activeSession] || { count: 0, last: 0 };
    const nextStats = {
      ...sessionStatsRef.current,
      [activeSession]: { count: cur.count + 1, last: Date.now() },
    };
    sessionStatsRef.current = nextStats;
    setSessionStats(nextStats);
    if (statsSaveTimer.current) clearTimeout(statsSaveTimer.current);
    statsSaveTimer.current = setTimeout(() => {
      updatePreferences({ sessionStats: sessionStatsRef.current });
    }, 1000);

    // "Recently used" freeze: don't reorder the list on this click. Only re-sort
    // once the user has settled on a session (no further switches for a while).
    // Each switch resets the timer, so browsing through sessions never reshuffles.
    if (recentSettleTimer.current) clearTimeout(recentSettleTimer.current);
    recentSettleTimer.current = setTimeout(() => {
      setRecentOrder((prev) => sortNamesByRecency(sessionNamesRef.current, prev));
    }, RECENT_SETTLE_MS);
  }, [activeSession]);

  // Keep a live snapshot of session names for the recency helpers (avoids stale closures)
  useEffect(() => {
    sessionNamesRef.current = sessions.map((s) => s.name);
  }, [sessions]);

  // Initialise the frozen recency order once prefs + sessions are available, then
  // reconcile it on add/remove: new sessions go to the top, removed ones drop out,
  // existing sessions keep their frozen positions (no reshuffle).
  useEffect(() => {
    if (!prefsLoaded) return;
    const names = sessions.map((s) => s.name);
    if (names.length === 0) return;
    setRecentOrder((prev) => {
      if (!recentInitedRef.current) {
        recentInitedRef.current = true;
        return sortNamesByRecency(names, []);
      }
      const nameSet = new Set(names);
      const prevSet = new Set(prev);
      const kept = prev.filter((n) => nameSet.has(n));
      const added = names.filter((n) => !prevSet.has(n));
      if (added.length === 0 && kept.length === prev.length) return prev;
      return [...added, ...kept];
    });
  }, [prefsLoaded, sessions]);

  // Refresh the recency order when the user switches INTO "recently used" so it
  // reflects current activity immediately (a deliberate mode change, not a click).
  useEffect(() => {
    if (sortBy === "recent" && recentInitedRef.current) {
      setRecentOrder((prev) => sortNamesByRecency(sessionNamesRef.current, prev));
    }
  }, [sortBy, sortNamesByRecency]);

  // Close bottom pane when switching sessions
  useEffect(() => {
    setBottomTab(null);
  }, [activeSession]);

  // Ctrl+Shift+[ / Ctrl+Shift+] to navigate MRU sessions
  // Use e.code (physical key) not e.key — Shift changes [ to { and ] to }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || !e.shiftKey) return;
      if (e.code !== "BracketLeft" && e.code !== "BracketRight") return;
      e.preventDefault();
      const list = mruList.current.filter((s) => sessions.some((sess) => sess.name === s));
      if (list.length < 2) return;

      const currentIdx = list.indexOf(activeSession ?? "");
      // BracketLeft = [ = go back (older), BracketRight = ] = go forward (more recent)
      const delta = e.code === "BracketLeft" ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(list.length - 1, currentIdx + delta));
      if (nextIdx === currentIdx) return;

      // Set flag so the MRU update effect doesn't reorder the list during navigation
      mruNavigating.current = true;
      setActiveSession(list[nextIdx]);
      setMobileShowTerminal(true);
      // Clear flag after state update has been processed
      setTimeout(() => { mruNavigating.current = false; }, 100);

      // Show switcher popup, auto-dismiss after 1.5s of inactivity
      setMruSwitcherVisible(true);
      if (mruDismissTimer.current) clearTimeout(mruDismissTimer.current);
      mruDismissTimer.current = setTimeout(() => setMruSwitcherVisible(false), 1500);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeSession, sessions, setActiveSession]);

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (mruDismissTimer.current) clearTimeout(mruDismissTimer.current);
    if (mruSaveTimer.current) clearTimeout(mruSaveTimer.current);
    if (statsSaveTimer.current) clearTimeout(statsSaveTimer.current);
    if (recentSettleTimer.current) clearTimeout(recentSettleTimer.current);
  }, []);

  // Build ordered session list: pinned first, then parents, then their children indented below
  const orderedSessions = useMemo(() => {
    const childNames = new Set<string>();
    for (const s of sessions) {
      if (s.parentSession) childNames.add(s.name);
    }

    // Separate parents into pinned and unpinned, preserving original order within each group
    const parents = sessions.filter((s) => !childNames.has(s.name));
    const pinnedParents = parents.filter((s) => pinnedSessions.has(s.name));
    const unpinnedParents = parents.filter((s) => !pinnedSessions.has(s.name));

    // Sort by usage when requested. Array.sort is stable, so never-used sessions
    // (missing stats) keep their existing server/manual order — no flip-flopping.
    const byUsage = (list: SessionInfo[]): SessionInfo[] => {
      if (sortBy === "recent") {
        // Use the frozen recency order (recentOrder), NOT live sessionStats, so
        // clicking a session doesn't reorder the list — see the settle logic above.
        const idx = new Map(recentOrder.map((n, i) => [n, i]));
        return [...list].sort(
          (a, b) =>
            (idx.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
            (idx.get(b.name) ?? Number.MAX_SAFE_INTEGER),
        );
      }
      if (sortBy === "frequent") {
        return [...list].sort((a, b) => {
          const ca = sessionStats[a.name]?.count ?? 0;
          const cb = sessionStats[b.name]?.count ?? 0;
          if (cb !== ca) return cb - ca;
          return (sessionStats[b.name]?.last ?? 0) - (sessionStats[a.name]?.last ?? 0);
        });
      }
      return list;
    };
    const sortedParents = [...byUsage(pinnedParents), ...byUsage(unpinnedParents)];

    const result: { session: SessionInfo; isChild: boolean; isLastChild: boolean; childrenSummary?: { total: number; working: number; done: number; error: number }; childrenExpanded: boolean; parentIdx: number }[] = [];
    let pIdx = 0;
    for (const session of sortedParents) {

      // Compute children summary for parents
      const childList = (session.children || [])
        .map((name) => sessions.find((s) => s.name === name))
        .filter(Boolean) as SessionInfo[];
      const childrenSummary = childList.length > 0 ? {
        total: childList.length,
        working: childList.filter((c) => c.status === "working").length,
        done: childList.filter((c) => getDisplayStatus(c) === "done" || c.status === "waiting").length,
        error: childList.filter((c) => getDisplayStatus(c) === "error").length,
      } : undefined;

      const isExpanded = !collapsedParents.has(session.name);
      const currentPIdx = pIdx++;

      result.push({ session, isChild: false, isLastChild: false, childrenSummary, childrenExpanded: isExpanded, parentIdx: currentPIdx });

      // Add children right after parent (if expanded)
      if (isExpanded && childList.length > 0) {
        childList.forEach((child, idx) => {
          result.push({
            session: child,
            isChild: true,
            isLastChild: idx === childList.length - 1,
            childrenExpanded: false,
            parentIdx: currentPIdx,
          });
        });
      }
    }
    return result;
  }, [sessions, collapsedParents, pinnedSessions, sortBy, sessionStats, recentOrder]);

  const filteredSessions = useMemo(() => {
    if (!sessionSearch.trim()) return orderedSessions;
    const q = sessionSearch.toLowerCase();
    // Collect matching parent names so we include their children too
    const matchingParents = new Set<string>();
    for (const entry of orderedSessions) {
      const s = entry.session;
      if (s.name.toLowerCase().includes(q)) {
        if (entry.isChild && s.parentSession) matchingParents.add(s.parentSession);
        else matchingParents.add(s.name);
      }
    }
    return orderedSessions.filter((entry) => {
      if (matchingParents.has(entry.session.name)) return true;
      if (entry.isChild && entry.session.parentSession && matchingParents.has(entry.session.parentSession)) return true;
      return false;
    });
  }, [orderedSessions, sessionSearch]);

  const groupedSessions = useMemo(() => {
    if (!groupBy) return null;
    const isStatusGroup = groupBy === "__status__";
    const isQueue = groupBy === "__queue__";
    const groups: Record<string, typeof filteredSessions> = {};
    const ungrouped: typeof filteredSessions = [];
    for (const entry of filteredSessions) {
      if (entry.isChild) continue;
      let value: string;
      if (isQueue) {
        value = queueBucket(entry.session);
      } else if (isStatusGroup) {
        value = getDisplayStatus(entry.session) || entry.session.status || "unknown";
      } else {
        value = entry.session.meta?.[groupBy] || "";
      }
      if (value) {
        if (!groups[value]) groups[value] = [];
        groups[value].push(entry);
      } else {
        ungrouped.push(entry);
      }
      // Also add children after their parent
      const childEntries = filteredSessions.filter(
        (e) => e.isChild && e.session.parentSession === entry.session.name
      );
      const target = value ? groups[value] : ungrouped;
      target!.push(...childEntries);
    }
    // The queue has one correct order, so it is fixed rather than sorted.
    if (isQueue) {
      const sorted: Record<string, typeof filteredSessions> = {};
      for (const b of QUEUE_BUCKETS) {
        if (groups[b.id] && groups[b.id]!.length) sorted[b.id] = groups[b.id]!;
      }
      return { groups: sorted, ungrouped: [] };
    }
    // For status grouping, order groups sensibly
    if (isStatusGroup) {
      const order = ["working", "background", "input", "error", "waiting", "done", "unknown", "stopped"];
      const sorted: Record<string, typeof filteredSessions> = {};
      for (const key of order) {
        if (groups[key]) sorted[key] = groups[key];
      }
      // Any remaining groups not in the order
      for (const key of Object.keys(groups)) {
        if (!sorted[key]) sorted[key] = groups[key];
      }
      return { groups: sorted, ungrouped };
    }
    return { groups, ungrouped };
  }, [filteredSessions, groupBy]);

  /* The phone's queue orders by what needs you, which is exactly what
     __queue__ grouping means — so only a different grouping has anything to
     add there. Without this the grouping control on the phone changed the
     desktop's list and nothing the reader could see. */
  const mobileGrouping = useMemo(() => {
    if (!groupBy || groupBy === "__queue__" || !groupedSessions) return null;
    const byName = new Map<string, string>();
    const order: string[] = [];
    for (const [value, entries] of Object.entries(groupedSessions.groups)) {
      const label = groupBy === "__status__"
        ? value.charAt(0).toUpperCase() + value.slice(1)
        : value;
      if (!order.includes(label)) order.push(label);
      for (const e of entries) byName.set(e.session.name, label);
    }
    if (groupedSessions.ungrouped.length > 0) {
      order.push("No value");
      for (const e of groupedSessions.ungrouped) byName.set(e.session.name, "No value");
    }
    return order.length > 0 ? { byName, order } : null;
  }, [groupBy, groupedSessions]);

  // Check if active session has children or is a child (for sub-agents tab & breadcrumb)
  const activeSessionInfo = sessions.find((s) => s.name === activeSession);
  const hasChildren = (activeSessionInfo?.children?.length ?? 0) > 0;
  const parentSessionInfo = activeSessionInfo?.parentSession
    ? sessions.find((s) => s.name === activeSessionInfo.parentSession)
    : null;

  // Resolve session paths — use worktree metadata if available, otherwise discover git repos
  const [discoveredPaths, setDiscoveredPaths] = useState<Record<string, string[]>>({});
  const activeSessionPaths = useMemo(() => {
    if (!activeSessionInfo) return [];
    if (activeSessionInfo.worktrees && activeSessionInfo.worktrees.length > 0) {
      return activeSessionInfo.worktrees.map((wt) => wt.wtDir);
    }
    if (activeSessionInfo.path && discoveredPaths[activeSessionInfo.name]) {
      return discoveredPaths[activeSessionInfo.name];
    }
    return activeSessionInfo.path ? [activeSessionInfo.path] : [];
  }, [activeSessionInfo, discoveredPaths]);

  // Async discovery for sessions without worktree metadata
  useEffect(() => {
    if (!activeSessionInfo?.path) return;
    if (activeSessionInfo.worktrees && activeSessionInfo.worktrees.length > 0) return;
    if (discoveredPaths[activeSessionInfo.name]) return;
    fetchGitRepos(activeSessionInfo.path).then((repos) => {
      if (repos.length > 0) {
        setDiscoveredPaths((prev) => ({ ...prev, [activeSessionInfo.name]: repos }));
      }
    });
  }, [activeSessionInfo?.name]);

  const handleKillSelected = async () => {
    if (selectedSessions.size === 0) return;
    await Promise.all([...selectedSessions].map(name => deleteSession(name).catch(() => {})));
    if (activeSession && selectedSessions.has(activeSession)) {
      const remaining = sessions.filter(s => !selectedSessions.has(s.name));
      setActiveSession(remaining.length > 0 ? remaining[0].name : null);
    }
    setSelectedSessions(new Set());
    setSelectionMode(false);
    refresh();
  };

  const handleExitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedSessions(new Set());
  };

  const handleToggleSelectAll = () => {
    if (selectedSessions.size === sessions.length) {
      setSelectedSessions(new Set());
    } else {
      setSelectedSessions(new Set(sessions.map(s => s.name)));
    }
  };

  const handleStopAll = async () => {
    if (!confirm("Stop all sessions?")) return;
    try {
      await deleteAllSessions();
      setActiveSession(null);
      refresh();
    } catch (err: any) {
      console.error("Failed to stop all sessions:", err);
    }
  };

  const handleStopped = () => {
    if (activeSession) {
      const remaining = sessions.filter((s) => s.name !== activeSession);
      if (remaining.length > 0) {
        setActiveSession(remaining[0].name);
      } else {
        setActiveSession(null);
      }
    }
    refresh();
  };

  const handlePinToHeader = useCallback(async (session: SessionInfo) => {
    // Derive targets from the session's repos
    const targets = session.worktrees?.length
      ? session.worktrees.map(wt => {
          const repoName = wt.repoPath.split("/").pop() || wt.repoPath;
          return repoName;
        })
      : session.path ? [session.path.split("/").pop() || session.displayName] : [session.displayName];
    const ql: QuickLaunch = {
      id: `ql-${Date.now().toString(36)}`,
      label: session.displayName,
      sessionName: session.displayName,
      targets,
      agentType: session.agentType,
    };
    const prefs = await fetchPreferences();
    const existing: QuickLaunch[] = prefs.quickLaunches || [];
    // Don't add duplicates (same targets)
    if (existing.some(q => q.targets.join(",") === targets.join(","))) return;
    const updated = [...existing, ql];
    await updatePreferences({ quickLaunches: updated });
    // Notify Header to refresh
    window.dispatchEvent(new CustomEvent("agentdock-quick-launches-changed"));
  }, []);

  // Get the list of parent session names in current order
  const parentSessionNames = useMemo(() => {
    return orderedSessions.filter((e) => !e.isChild).map((e) => e.session.name);
  }, [orderedSessions]);

  const handleDragStart = useCallback((parentIdx: number) => (e: React.DragEvent) => {
    setDragIdx(parentIdx);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((parentIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(parentIdx);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragIdx(null);
    setDragOverIdx(null);
  }, []);

  const handleDrop = useCallback((targetParentIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === targetParentIdx) {
      setDragIdx(null);
      setDragOverIdx(null);
      return;
    }
    const newOrder = [...parentSessionNames];
    const [moved] = newOrder.splice(dragIdx, 1);
    newOrder.splice(targetParentIdx, 0, moved);
    reorderSessions(newOrder);
    setDragIdx(null);
    setDragOverIdx(null);
    refresh();
  }, [dragIdx, parentSessionNames, refresh]);

  const handleSessionClosed = () => {
    // session killed externally
  };

  const handleRestoreSession = useCallback(async (name: string) => {
    try {
      await restoreSession(name);
    } catch (err) {
      console.error("Failed to restore session:", err);
    }
    refresh();
  }, [refresh]);

  const handleForkSession = useCallback(async (session: SessionInfo) => {
    const worktree = session.worktrees?.[0];
    const path = worktree?.wtDir || worktree?.repoPath || session.path;
    if (!path) return;
    try {
      const { sessions: created } = await createSession({
        targets: [path],
        dangerouslySkipPermissions: true,
        agentType: session.agentType || "claude",
      });
      if (created?.[0]) {
        setActiveSession(created[0]);
        setMobileShowTerminal(true);
        refresh();
      }
    } catch (err) {
      console.error("Failed to fork session:", err);
    }
  }, [refresh]);

  // Auto-select first session if none selected, or fix stale selection
  useEffect(() => {
    if (loading) return; // don't touch URL param while sessions are loading
    if (!sessions.length) {
      if (activeSession) setActiveSession(null);
      return;
    }
    // Only auto-open something that actually wants attention. When nothing is
    // blocked, reviewable or running, leaving the selection empty is what lets
    // the quiet state show — the design's point being that "nothing needs you"
    // deserves saying out loud rather than dropping you into an idle terminal.
    const live = sessions.filter((s) => {
      const b = queueBucket(s);
      return b === "blocked" || b === "review" || b === "working";
    });
    const stillThere = activeSession && sessions.find((s) => s.name === activeSession);
    if (!stillThere) {
      if (live.length > 0) setActiveSession(live[0].name);
      else if (activeSession) setActiveSession(null);
    }
  }, [sessions, loading, activeSession, setActiveSession]);

  // On load with session param, show terminal on mobile
  useEffect(() => {
    if (activeSession && isMobile) {
      setMobileShowTerminal(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show terminal when fix-me / quick-launch navigates to a session
  useEffect(() => {
    const handler = () => { if (isMobile) setMobileShowTerminal(true); };
    window.addEventListener("agentdock-mobile-show-terminal", handler);
    return () => window.removeEventListener("agentdock-mobile-show-terminal", handler);
  }, [isMobile]);

  // Sync mobile nav context
  const { setInSession, setGoBack, setSessionTitle } = mobileNav ?? {};
  useEffect(() => {
    setInSession?.(!!(mobileShowTerminal && activeSession));
  }, [mobileShowTerminal, activeSession, setInSession]);

  useEffect(() => {
    setGoBack?.(() => setMobileShowTerminal(false));
  }, [setGoBack]);

  // Notify across the whole queue, not just the session on screen.
  useQueueNotifications(sessions, activeSession, {
    enabled: appSettings.notificationsEnabled,
    blocked: appSettings.notifyBlocked,
    review: appSettings.notifyReview,
    quietEnabled: appSettings.notifyQuietEnabled,
    quietStart: appSettings.notifyQuietStart,
    quietEnd: appSettings.notifyQuietEnd,
  });

  // Read hook state when the wizard reaches that step.
  useEffect(() => {
    if (setupStep !== "hooks") return;
    fetchHookState().then(setSetupHooks).catch(() => setSetupHooks(null));
  }, [setupStep]);

  const handleSetupInstallHooks = async () => {
    setSetupHooksBusy(true);
    try {
      const r = await installHooks();
      if (r.ok) setSetupHooks(r);
    } finally {
      setSetupHooksBusy(false);
    }
  };

  /* Shells outlive a reload, so which ones exist is the server's answer, asked
     again whenever the session changes. */
  useEffect(() => {
    if (!activeSession) { setShells([]); return; }
    let alive = true;
    setShells([]);
    fetchShells(activeSession).then((s) => { if (alive) setShells(s); }).catch(() => {});
    return () => { alive = false; };
  }, [activeSession]);

  const addShell = useCallback(async () => {
    if (!activeSession || shellBusy || shells.length >= 2) return;
    setShellBusy(true);
    try {
      setShells(await openShell(activeSession));
    } catch {
      /* Nothing to say here that the missing pane does not say already. */
    } finally {
      setShellBusy(false);
    }
  }, [activeSession, shellBusy, shells.length]);

  const dropShell = useCallback(async (shell: string) => {
    if (!activeSession) return;
    const index = Number(shell.slice(shell.lastIndexOf("-") + 1));
    setShells((prev) => prev.filter((s) => s !== shell));
    try {
      setShells(await closeShell(activeSession, index));
    } catch {
      /* Already gone. */
    }
  }, [activeSession]);

  // One call feeds every panel badge, so they cannot disagree with each other.
  useEffect(() => {
    if (!activeSession || activeSessionPaths.length === 0) { setPanelSummary(null); return; }
    let alive = true;
    /* Cleared first: this effect only re-runs when the session or its paths
       change, so anything still on screen belongs to the session you just left. */
    setPanelSummary(null);
    fetchPanelSummary(activeSession, activeSessionPaths)
      .then((t) => {
        if (!alive) return;
        setPanelSummary({
          planDone: t.plan.done,
          planTotal: t.plan.total,
          plus: t.diff.plus,
          minus: t.diff.minus,
          fileCount: t.diff.files,
        });
      })
      .catch(() => { if (alive) setPanelSummary(null); });
    return () => { alive = false; };
  }, [activeSession, activeSessionPaths.join("|")]);

  /**
   * Jump to whatever costs you most right now. Deciding what to look at next
   * is itself part of the coordination cost the queue exists to reduce, so it
   * is one keystroke rather than a scan.
   */
  const goNext = useCallback(() => {
    const order = ["blocked", "review", "working", "idle", "stale"] as const;
    const live = sessions.filter((x) => !x.parentSession);
    for (const bucket of order) {
      const candidates = live.filter((x) => queueBucket(x) === bucket);
      if (candidates.length === 0) continue;
      const at = candidates.findIndex((x) => x.name === activeSession);
      const target = candidates[(at + 1) % candidates.length];
      if (target) {
        setActiveSession(target.name);
        setMobileShowTerminal(true);
      }
      return;
    }
  }, [sessions, activeSession, setActiveSession]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "n" || e.key === "N") { e.preventDefault(); goNext(); }
      if (e.key === "Escape") setFullSurface(null);
    };
    const onEvent = () => goNext();
    window.addEventListener("keydown", onKey);
    window.addEventListener("agentdock-queue-next", onEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("agentdock-queue-next", onEvent);
    };
  }, [goNext]);

  useEffect(() => {
    if (!activeSession) { setSharedWith(null); return; }
    let alive = true;
    const short = activeSession.replace(/^claude-/, "");
    fetchConflicts()
      .then((r) => {
        if (!alive) return;
        const hit = r.conflicts.find((c) => c.sessions.includes(short));
        setSharedWith(hit ? { session: hit.sessions.find((x) => x !== short) ?? hit.sessions[1], files: hit.files.length } : null);
      })
      .catch(() => alive && setSharedWith(null));
    return () => { alive = false; };
  }, [activeSession]);

  const togglePanel = useCallback((id: string) => {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  /** A count only where it means something you would act on. */
  // What is waiting on you, so the Sessions button carries the same kind of
  // badge the surface buttons do.
  /**
   * Collapse or expand every group in the current grouping.
   *
   * Both the label and the action key off *this* grouping's keys.
   * collapsedGroups is shared across groupings, so leftovers from another one —
   * queue buckets while you are grouped by status, say — used to make the label
   * read "Expand all groups" over groups that were plainly expanded, and the
   * click then did the opposite of what it said.
   */
  /**
   * The same control in two places. On a phone the sidebar sits behind the
   * queue overlay, so the sidebar copy is unreachable — grouping could not be
   * changed there at all. Defined once so the option list cannot drift.
   */
  const modeSelect = (className: string) => (
    <select
      className={className}
      data-tutorial="group-by-select"
      title="Sort or group sessions"
      value={sortBy || groupBy}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "recent" || v === "frequent") {
          setSortBy(v);
          setGroupBy("");
          updatePreferences({ sortBy: v, groupBy: "" });
        } else {
          setGroupBy(v);
          setSortBy("");
          updatePreferences({ groupBy: v, sortBy: "" });
        }
      }}
    >
      <option value="__queue__">Queue</option>
      <option value="">Flat list</option>
      <optgroup label="Sort by">
        <option value="recent">Recently used</option>
        <option value="frequent">Most used</option>
      </optgroup>
      <optgroup label="Group by">
        <option value="__status__">Status</option>
        {metaPresets.map((p) => (
          <option key={p.key} value={p.key}>{p.label}</option>
        ))}
      </optgroup>
    </select>
  );

  const groupCollapseAction = useMemo(() => {
    if (!groupBy || !groupedSessions) return undefined;
    const keys = Object.keys(groupedSessions.groups);
    if (groupedSessions.ungrouped.length > 0) keys.push("__ungrouped__");
    if (keys.length === 0) return undefined;
    const allCollapsed = keys.every((k) => collapsedGroups.has(k));
    return {
      label: allCollapsed ? "Expand all groups" : "Collapse all groups",
      run: () => {
        const next = allCollapsed
          ? new Set([...collapsedGroups].filter((k) => !keys.includes(k)))
          : new Set([...collapsedGroups, ...keys]);
        setCollapsedGroups(next);
        updatePreferences({ collapsedGroups: [...next] });
      },
    };
  }, [groupBy, groupedSessions, collapsedGroups]);

  const sessionsBadge = useMemo(
    () => sessions.filter((x) => !x.parentSession && queueBucket(x) === "blocked").length,
    [sessions],
  );

  const railBadge = useCallback((id: FullSurface): string => {
    if (id === "sub-agents") {
      const kids = activeSessionInfo?.children?.length ?? 0;
      return kids > 0 ? String(kids) : "";
    }
    if (!panelSummary) return "";
    if (id === "changes") return panelSummary.fileCount > 0 ? String(panelSummary.fileCount) : "";
    if (id === "plan") {
      const left = panelSummary.planTotal - panelSummary.planDone;
      return panelSummary.planTotal > 0 && left > 0 ? String(left) : "";
    }
    return "";
  }, [panelSummary, activeSessionInfo]);

  const panelSummaryLine = useCallback((id: string): string => {
    const kids = activeSessionInfo?.children?.length ?? 0;
    if (id === "sub-agents") {
      if (kids === 0) return "This agent has not delegated anything.";
      const blocked = (activeSessionInfo?.children ?? [])
        .map((c) => sessions.find((x) => x.name === c))
        .filter((c) => c && queueBucket(c) === "blocked").length;
      return blocked > 0
        ? `${kids} sub-agent${kids === 1 ? "" : "s"}, ${blocked} waiting on you.`
        : `${kids} sub-agent${kids === 1 ? "" : "s"} running under this session.`;
    }
    if (!panelSummary) return "Reading the worktree\u2026";
    if (id === "plan") {
      if (panelSummary.planTotal === 0) return "No plan file for this session yet.";
      const left = panelSummary.planTotal - panelSummary.planDone;
      return `${panelSummary.planDone} of ${panelSummary.planTotal} steps done, ${left} still open.`;
    }
    if (id === "changes") {
      if (panelSummary.fileCount === 0) return "Nothing has changed in this worktree yet.";
      return `${panelSummary.fileCount} file${panelSummary.fileCount === 1 ? "" : "s"} changed, +${panelSummary.plus} \u2212${panelSummary.minus}.`;
    }
    if (id === "files") {
      return panelSummary.fileCount > 0
        ? `${panelSummary.fileCount} changed file${panelSummary.fileCount === 1 ? "" : "s"} in this tree.`
        : "Browse the worktree.";
    }
    return "";
  }, [panelSummary, activeSessionInfo, sessions]);

  const panelBadge = useCallback((id: string): string => {
    const kids = activeSessionInfo?.children?.length ?? 0;
    if (id === "sub-agents") return kids > 0 ? String(kids) : "";
    if (!panelSummary) return "";
    if (id === "plan") return panelSummary.planTotal > 0 ? `${panelSummary.planDone} / ${panelSummary.planTotal}` : "";
    if (id === "changes") return panelSummary.plus + panelSummary.minus > 0 ? `+${panelSummary.plus} \u2212${panelSummary.minus}` : "";
    return "";
  }, [panelSummary, activeSessionInfo]);

  useEffect(() => { setMobileApproveDismissed(false); }, [activeSession]);

  const mobileInSession = mobileShowTerminal && !!activeSession;

  // Sync session title for mobile header
  useEffect(() => {
    if (mobileInSession && activeSessionInfo) {
      setSessionTitle?.(activeSessionInfo.displayName);
    } else {
      setSessionTitle?.("");
    }
  }, [mobileInSession, activeSessionInfo, setSessionTitle]);

  // Keyboard open state — hides bottom nav
  const [kbOpen, setKbOpen] = useState(false);
  useEffect(() => {
    document.body.classList.toggle("mobile-kb-open", kbOpen);
    return () => { document.body.classList.remove("mobile-kb-open"); };
  }, [kbOpen]);

  /* The header's height and the nav's height were both hard-coded guesses —
     48px and 52px — and both were wrong on a phone: the nav carries the home
     indicator inset on top of its content, so the 52px body padding left the
     terminal's toolbar buried under it. Measure them and publish the real
     numbers instead. */
  useEffect(() => {
    const root = document.documentElement;
    const measure = () => {
      const header = document.querySelector(".header") as HTMLElement | null;
      const nav = document.querySelector(".mobile-bottom-nav") as HTMLElement | null;
      root.style.setProperty("--app-header-b", `${Math.round(header?.getBoundingClientRect().bottom ?? 48)}px`);
      root.style.setProperty("--mobile-nav-h", `${Math.round(nav?.getBoundingClientRect().height ?? 0)}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    const header = document.querySelector(".header");
    const nav = document.querySelector(".mobile-bottom-nav");
    if (header) ro.observe(header);
    if (nav) ro.observe(nav);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [isMobile, mobileInSession, kbOpen]);

  return (
    <>
    <div className={`split-layout ${mobileInSession ? "mobile-show-terminal" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {/* Global navigation, at the outside edge. Sessions and Worktrees belong
          to no one session, so they do not belong in the rail on the right —
          that one is what you do *to* the session you have open. */}
      {!isMobile && (
        <nav className="app-rail app-rail-left" aria-label="Everything">
          <button
            className={`rail-btn${!fullSurface ? " rail-btn-active" : ""}`}
            onClick={() => setFullSurface(null)}
            title="Sessions"
            aria-label="Sessions"
            aria-pressed={!fullSurface}
          >
            <Icon name="layers" size={18} />
            {sessionsBadge > 0 && <span className="rail-badge rail-badge-sessions">{sessionsBadge}</span>}
          </button>
          <button
            className={`rail-btn${fullSurface === "worktrees" ? " rail-btn-active" : ""}`}
            onClick={() => setFullSurface(fullSurface === "worktrees" ? null : "worktrees")}
            title="Worktrees"
            aria-label="Worktrees"
            aria-pressed={fullSurface === "worktrees"}
          >
            <Icon name="branch" size={18} />
          </button>
        </nav>
      )}
      {(isMobile || !fullSurface) && (
      <div className="split-sidebar">
        <div className="sidebar-header">
          <div className="sidebar-search">
            <Icon name="search" size={13} />
            <input
              ref={sessionSearchRef}
              type="text"
              className="sidebar-search-input"
              placeholder="Search sessions…"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSessionSearch("");
                  sessionSearchRef.current?.blur();
                }
              }}
            />
            {sessionSearch ? (
              <button className="sidebar-search-clear" onClick={() => setSessionSearch("")} aria-label="Clear search">&times;</button>
            ) : (
              <kbd className="sidebar-search-kbd">&#8984;K</kbd>
            )}
          </div>
          <button
            className="sidebar-iconbtn"
            onClick={() => setSidebarCollapsed(true)}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <Icon name="chevl" size={14} />
          </button>
        </div>

        <div className="sidebar-controls">
          {selectionMode ? (
            <>
              <span className="sidebar-count">{selectedSessions.size} selected</span>
              <span className="sidebar-controls-spacer" />
              <button className="sidebar-textbtn" onClick={handleExitSelectionMode}>cancel</button>
            </>
          ) : (
            <>
              {modeSelect("sidebar-mode")}

              <span className="sidebar-controls-spacer" />
              <span className="sidebar-count">
                {sessions.length} session{sessions.length === 1 ? "" : "s"}
              </span>
              <SidebarMenu
                canSelect={sessions.length > 1}
                canKillAll={sessions.length > 0}
                onSelect={() => setSelectionMode(true)}
                onKillAll={handleStopAll}
                groupAction={groupCollapseAction}
              />
            </>
          )}
        </div>
        {missingTools.length > 0 && !missingToolsDismissed && (
          <div className="missing-tools-banner">
            <span className="missing-tools-icon"><Icon name="alert" size={14} /></span>
            <span className="missing-tools-text">
              Required tool{missingTools.length > 1 ? "s" : ""} not installed:{" "}
              <strong>{missingTools.join(", ")}</strong>.
              {" "}Check Settings → Health for install instructions.
            </span>
            <button className="missing-tools-dismiss" onClick={() => setMissingToolsDismissed(true)}><Icon name="close" size={13} /></button>
          </div>
        )}
        <div className="session-list" data-tutorial="session-list">
          {loading ? (
            <div className="loading">LOADING...</div>
          ) : sessions.length === 0 ? (
            <div className="empty-state">
              <pre className="ascii-art">{ASCII_LOGO}</pre>
              <p>no active sessions</p>
              <button className="btn btn-primary" onClick={() => navigate("/create")}>
                ./create-session
              </button>
            </div>
          ) : groupBy && groupedSessions ? (
            <>
              {Object.entries(groupedSessions.groups).map(([value, entries]) => (
                <div
                  key={value}
                  className={`session-group ${groupBy !== "__status__" && groupBy !== "__queue__" && dragIdx !== null ? "session-group-drop-target" : ""}`}
                  onDragOver={groupBy !== "__status__" && groupBy !== "__queue__" ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } : undefined}
                  onDrop={groupBy !== "__status__" && groupBy !== "__queue__" ? (e) => {
                    e.preventDefault();
                    const sessionName = e.dataTransfer.getData("text/plain");
                    if (sessionName) {
                      updateSessionMeta(sessionName, { [groupBy]: value });
                      refresh();
                    }
                  } : undefined}
                >
                  <div
                    className="session-group-header"
                    onClick={() => toggleGroup(value)}
                  >
                    <span className="session-group-chevron"><Icon name={collapsedGroups.has(value) ? "chevr" : "chev"} size={12} /></span>
                    <span className={`session-group-label ${groupBy === "__status__" ? `status-${value}` : ""} ${groupBy === "__queue__" ? `queue-${value}` : ""}`}>
                      {groupBy === "__queue__"
                        ? (QUEUE_BUCKETS.find((b) => b.id === value)?.label ?? value)
                        : value}
                    </span>
                    <span className="session-group-count">{entries.filter(e => !e.isChild).length}</span>
                    {groupBy === "__queue__" && (
                      <span className="session-group-cost">
                        {QUEUE_BUCKETS.find((b) => b.id === value)?.cost}
                      </span>
                    )}
                    {groupBy !== "__status__" && groupBy !== "__queue__" && (
                      <button
                        className="session-group-add"
                        onClick={(e) => { e.stopPropagation(); navigate(`/create?${groupBy}=${encodeURIComponent(value)}`); }}
                        title={`New session in ${value}`}
                      >+</button>
                    )}
                  </div>
                  {!collapsedGroups.has(value) && entries.map(({ session, isChild, isLastChild, childrenSummary, childrenExpanded, parentIdx }) => (
                    <SessionRow
                      key={session.name}
                      session={session}
                      active={session.name === activeSession}
                      isChild={isChild}
                      isLastChild={isLastChild}
                      childrenSummary={childrenSummary}
                      childrenExpanded={childrenExpanded}
                      onToggleChildren={() => toggleParentCollapse(session.name)}
                      pinned={pinnedSessions.has(session.name)}
                      onTogglePin={!isChild ? () => togglePin(session.name) : undefined}
                      onSelect={() => {
                        setActiveSession(session.name);
                        setMobileShowTerminal(true);
                      }}
                      onStopped={handleStopped}
                      draggable={!isChild}
                      onDragStart={!isChild ? (e: React.DragEvent) => { e.dataTransfer.setData("text/plain", session.name); setDragIdx(parentIdx); } : undefined}
                      onDragEnd={!isChild ? handleDragEnd : undefined}
                      isDragging={!isChild && dragIdx === parentIdx}
                      onEditProps={() => setEditingSession(session)}
                      onPinToHeader={() => handlePinToHeader(session)}
                      onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                      onForkSession={session.status !== "stopped" ? () => handleForkSession(session) : undefined}
                      dataTutorial={getDemoTutorialAttr(session)}
                      selectionMode={selectionMode}
                      selected={selectedSessions.has(session.name)}
                      onToggleSelect={() => setSelectedSessions(prev => { const next = new Set(prev); next.has(session.name) ? next.delete(session.name) : next.add(session.name); return next; })}
                    />
                  ))}
                </div>
              ))}
              {groupedSessions.ungrouped.length > 0 && (
                <div
                  className={`session-group ${dragIdx !== null ? "session-group-drop-target" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const sessionName = e.dataTransfer.getData("text/plain");
                    if (sessionName) {
                      updateSessionMeta(sessionName, { [groupBy]: "" });
                      refresh();
                    }
                  }}
                >
                  <div
                    className="session-group-header session-group-ungrouped"
                    onClick={() => toggleGroup("__ungrouped__")}
                  >
                    <span className="session-group-chevron"><Icon name={collapsedGroups.has("__ungrouped__") ? "chevr" : "chev"} size={12} /></span>
                    <span className="session-group-label">Ungrouped</span>
                    <span className="session-group-count">{groupedSessions.ungrouped.filter(e => !e.isChild).length}</span>
                  </div>
                  {!collapsedGroups.has("__ungrouped__") && groupedSessions.ungrouped.map(({ session, isChild, isLastChild, childrenSummary, childrenExpanded, parentIdx }) => (
                    <SessionRow
                      key={session.name}
                      session={session}
                      active={session.name === activeSession}
                      isChild={isChild}
                      isLastChild={isLastChild}
                      childrenSummary={childrenSummary}
                      childrenExpanded={childrenExpanded}
                      onToggleChildren={() => toggleParentCollapse(session.name)}
                      pinned={pinnedSessions.has(session.name)}
                      onTogglePin={!isChild ? () => togglePin(session.name) : undefined}
                      onSelect={() => {
                        setActiveSession(session.name);
                        setMobileShowTerminal(true);
                      }}
                      onStopped={handleStopped}
                      draggable={!isChild}
                      onDragStart={!isChild ? (e: React.DragEvent) => { e.dataTransfer.setData("text/plain", session.name); setDragIdx(parentIdx); } : undefined}
                      onDragEnd={!isChild ? handleDragEnd : undefined}
                      isDragging={!isChild && dragIdx === parentIdx}
                      onEditProps={() => setEditingSession(session)}
                      onPinToHeader={() => handlePinToHeader(session)}
                      onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                      onForkSession={session.status !== "stopped" ? () => handleForkSession(session) : undefined}
                      dataTutorial={getDemoTutorialAttr(session)}
                      selectionMode={selectionMode}
                      selected={selectedSessions.has(session.name)}
                      onToggleSelect={() => setSelectedSessions(prev => { const next = new Set(prev); next.has(session.name) ? next.delete(session.name) : next.add(session.name); return next; })}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            filteredSessions.map(({ session, isChild, isLastChild, childrenSummary, childrenExpanded, parentIdx }) => (
              <SessionRow
                key={session.name}
                session={session}
                active={session.name === activeSession}
                isChild={isChild}
                isLastChild={isLastChild}
                childrenSummary={childrenSummary}
                childrenExpanded={childrenExpanded}
                onToggleChildren={() => toggleParentCollapse(session.name)}
                pinned={pinnedSessions.has(session.name)}
                onTogglePin={!isChild ? () => togglePin(session.name) : undefined}
                onSelect={() => {
                  setActiveSession(session.name);
                  setMobileShowTerminal(true);
                }}
                onStopped={handleStopped}
                draggable={!isChild && sortBy === ""}
                onDragStart={!isChild && sortBy === "" ? handleDragStart(parentIdx) : undefined}
                onDragOver={!isChild && sortBy === "" ? handleDragOver(parentIdx) : undefined}
                onDragEnd={!isChild && sortBy === "" ? handleDragEnd : undefined}
                onDrop={!isChild && sortBy === "" ? handleDrop(parentIdx) : undefined}
                isDragging={!isChild && sortBy === "" && dragIdx === parentIdx}
                isDragOver={!isChild && sortBy === "" && dragOverIdx === parentIdx && dragIdx !== parentIdx}
                onEditProps={() => setEditingSession(session)}
                onPinToHeader={() => handlePinToHeader(session)}
                onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                dataTutorial={getDemoTutorialAttr(session)}
                selectionMode={selectionMode}
                selected={selectedSessions.has(session.name)}
                onToggleSelect={() => setSelectedSessions(prev => { const next = new Set(prev); next.has(session.name) ? next.delete(session.name) : next.add(session.name); return next; })}
              />
            ))
          )}
        </div>
        {selectionMode && (
          <div className="selection-action-bar">
            <button className="selection-select-all" onClick={handleToggleSelectAll}>
              {selectedSessions.size === sessions.length ? "none" : "all"}
            </button>
            <span className="selection-count">
              {selectedSessions.size > 0 ? `${selectedSessions.size} selected` : "tap to select"}
            </span>
            <button
              className="btn btn-stop btn-sm"
              onClick={handleKillSelected}
              disabled={selectedSessions.size === 0}
            >
              kill {selectedSessions.size > 0 ? selectedSessions.size : ""}
            </button>
          </div>
        )}
      </div>
      )}

      <div className="split-main">
        {activeSession ? (
          <>
            {/* The surface carries its own identity strip, and the rail is
                always on screen, so this bar would be a second header offering
                a jump the rail already offers. */}
            <div className="main-tabs" hidden={!isMobile && !!fullSurface}>
              {sidebarCollapsed && (
                <button
                  className="main-tab sidebar-expand-btn"
                  onClick={() => setSidebarCollapsed(false)}
                  title="Expand sidebar"
                >
                  <Icon name="chevr" size={14} />
                </button>
              )}
              <button
                className="main-tab mobile-back-btn"
                onClick={() => setMobileShowTerminal(false)}
              >
                &lt; sessions
              </button>
              {parentSessionInfo && (
                <button
                  className="main-tab session-breadcrumb"
                  onClick={() => {
                    setActiveSession(parentSessionInfo.name);
                    setActiveTab("sub-agents");
                  }}
                  title={`Back to parent: ${parentSessionInfo.displayName}`}
                >
                  <span className="breadcrumb-parent">{parentSessionInfo.displayName}</span>
                  <span className="breadcrumb-sep">/</span>
                  <span className="breadcrumb-child">{activeSessionInfo?.displayName}</span>
                </button>
              )}
              {!isMobile && activeSessionInfo?.status !== "stopped" && (
                <button
                  className="main-tab review-enter"
                  onClick={() => setFullSurface("changes")}
                  title="Review this session's changes in a full window"
                >
                  <Icon name="diff" size={14} />
                  review
                  {/* Was the count of files no plan step accounted for. That was
                      the Coverage tab's number and it went with it; how many
                      files there are to read is the honest one for a button
                      that opens the diff. */}
                  {panelSummary && panelSummary.fileCount > 0 && (
                    <span className="review-enter-badge">{panelSummary.fileCount}</span>
                  )}
                </button>
              )}
              <div className="main-tabs-toolbar" ref={toolbarRef} />
            </div>
            <div className="main-content main-content-split" ref={splitContainerRef}>
              {/* One surface at a time in the main area, chosen from the rail.
                  There is no second row of tabs: the rail stays visible, so the
                  thing you would switch with is already on screen. */}
              {!isMobile && fullSurface && (activeSession || fullSurface === "worktrees") ? (
                <div className="surface-pane">
                  {/* The way out, then identity. The rail can close a surface by
                      pressing its icon again, and the session name here has always
                      been a button, but neither looks like the way back — so a
                      reader who wanted the terminal reloaded the page. */}
                  <div className="surface-head">
                    <button
                      className="surface-back"
                      onClick={() => setFullSurface(null)}
                      title="Back to the terminal"
                    >
                      <Icon name="chevl" size={13} />
                      <span>terminal</span>
                    </button>
                    <span className="surface-head-sep">/</span>
                    <span className="surface-head-name">
                      {fullSurface === "worktrees"
                        ? "Worktrees"
                        : RAIL.find((r) => r.id === fullSurface)?.label ?? fullSurface}
                    </span>
                    {/* Worktrees belongs to no session, so naming one here would
                        be a lie about what you are looking at. */}
                    {fullSurface !== "worktrees" && (
                      <>
                        <span className="surface-head-sep">/</span>
                        <button
                          className="surface-head-session"
                          onClick={() => setFullSurface(null)}
                          title="Back to the terminal"
                        >
                          {activeSessionInfo?.displayName ?? activeSession}
                        </button>
                      </>
                    )}
                    <span className="surface-head-spacer" />
                    <span className="surface-head-path">
                      {fullSurface === "worktrees" ? "" : activeSessionPaths[0] ?? ""}
                    </span>
                  </div>
                  {fullSurface === "worktrees" ? (
                    <WorktreesView activeSession={activeSession} onOpenSession={jumpToSession} />
                  ) : fullSurface === "changes" ? (
                    <ChangesView key={activeSession} sessionName={activeSession} sessionPaths={activeSessionPaths} onCommentsSent={() => setFullSurface(null)} />
                  ) : fullSurface === "plan" ? (
                    <PlanView key={activeSession} sessionName={activeSession} viewMode={planViewMode} />
                  ) : fullSurface === "files" ? (
                    <FileExplorer ref={fileExplorerRef} roots={activeSessionPaths} sessionName={activeSession} onClose={() => setFullSurface(null)} />
                  ) : (
                    <SubAgentsView
                      key={activeSession}
                      parentSession={activeSession}
                      sessions={sessions}
                      onSelectChild={jumpToSession}
                      onRefresh={refresh}
                    />
                  )}
                </div>
              ) : (
              <div className="split-terminal-pane" data-tutorial="terminal-pane" style={bottomTab ? { height: bottomMaximized ? "0%" : `${splitRatio * 100}%` } : undefined}>
                {activeSessionInfo?.status === "stopped" ? (
                  <div className="stopped-session-placeholder">
                    <div className="stopped-session-icon"><Icon name="clock" size={40} strokeWidth={1.4} /></div>
                    <div className="stopped-session-title">{activeSessionInfo.displayName}</div>
                    <div className="stopped-session-desc">This session stopped (e.g. after a reboot).<br />Restore it to resume with full conversation history.</div>
                    <button
                      className="btn btn-primary stopped-session-restore-btn"
                      onClick={() => handleRestoreSession(activeSession)}
                    >
                      <><Icon name="refresh" size={15} /> Restore Session</>
                    </button>
                  </div>
                ) : (!isMobile || mobileShowTerminal) && (
                  <div className={`term-split${!isMobile && shells.length > 0 ? " term-split-open" : ""}`}>
                    <div className="term-split-agent">
                      <TerminalView
                        key={activeSession}
                        sessionName={activeSession}
                        agentType={sessions.find((s) => s.name === activeSession)?.agentType}
                        onClosed={handleSessionClosed}
                        onAgentSwitched={refresh}
                        toolbarPortal={toolbarRef}
                        onSwipeBack={() => setMobileShowTerminal(false)}
                        onKeyboardVisibilityChange={setKbOpen}
                        isActive={!bottomTab}
                      />
                    </div>
                    {/* Desktop only: on a phone there is no room to split, and
                        the agent is what you came for. */}
                    {!isMobile && shells.length > 0 && (
                      <div className="term-shells">
                        {shells.map((shell) => (
                          <div className="term-shell" key={shell}>
                            <div className="term-shell-head">
                              <Icon name="term" size={12} />
                              <span className="term-shell-name">shell</span>
                              <span className="term-shell-path">
                                {(activeSessionPaths[0] || "").split("/").filter(Boolean).pop()}
                              </span>
                              <button
                                className="term-shell-close"
                                onClick={() => dropShell(shell)}
                                title="Close this shell"
                                aria-label="Close this shell"
                              >
                                ×
                              </button>
                            </div>
                            <div className="term-shell-body">
                              <TerminalView key={shell} sessionName={shell} isActive={false} bare />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              )}

              {!isMobile && !fullSurface && (
                <div className="term-status">
                  <span className="term-status-live">
                    <span className="term-status-dot" />connected
                  </span>
                  <span className="term-status-path">{activeSessionPaths[0] ?? activeSessionInfo?.path ?? ""}</span>
                  {panelSummary && (panelSummary.plus + panelSummary.minus > 0) && (
                    <span className="term-status-diff">
                      +{panelSummary.plus} &minus;{panelSummary.minus}
                    </span>
                  )}
                  <span className="term-status-agent">
                    {activeSessionInfo?.agentType === "cursor" ? "cursor" : "claude"}
                  </span>
                </div>
              )}
              {/* The right rail: icons only. Pressing one opens the surface
                  fully expanded, rather than docking it in a column. */}
              {!isMobile ? (
                <></>
              ) : (
                <>
                  <div className={`split-bottom-bar${bottomTab ? " split-bottom-bar-open" : ""}`}>
                    <div className="split-bottom-tabs" />
                  </div>
                  {bottomTab && (
                    <div className="split-bottom-pane" style={{ height: bottomMaximized ? "100%" : `${(1 - splitRatio) * 100}%` }}>
                      {bottomTab === "changes" ? (
                        <ChangesView key={activeSession} sessionName={activeSession} sessionPaths={activeSessionPaths} onCommentsSent={() => setBottomTab(null)} />
                      ) : bottomTab === "sub-agents" && hasChildren ? (
                        <SubAgentsView key={activeSession} parentSession={activeSession} sessions={sessions} onSelectChild={(c) => { setActiveSession(c); setBottomTab(null); setMobileShowTerminal(true); }} onRefresh={refresh} />
                      ) : bottomTab === "files" ? (
                        <FileExplorer ref={fileExplorerRef} roots={activeSessionPaths} sessionName={activeSession} onClose={() => setBottomTab(null)} />
                      ) : (
                        <PlanView key={activeSession} sessionName={activeSession} viewMode={planViewMode} />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <QuietView
            staleSessions={sessions
              .filter((x) => queueBucket(x) === "stale")
              .map((x) => ({
                name: x.name,
                displayName: x.displayName,
                repo: (x.path || "").split("/").filter(Boolean).pop() || "—",
                age: timeAgo(x.created),
              }))}
            onRestore={handleRestoreSession}
            onRestoreAll={() => {
              sessions
                .filter((x) => queueBucket(x) === "stale")
                .forEach((x) => handleRestoreSession(x.name));
            }}
            onStart={(kind) => {
              if (kind === "chat") {
                createSession({ targets: [], name: "general-chat", dangerouslySkipPermissions: true })
                  .then((r) => { if (r.sessions?.[0]) setActiveSession(r.sessions[0]); refresh(); })
                  .catch(() => {});
              } else {
                navigate("/create");
              }
            }}
          />
        )}
      </div>

      {showSetup && (
        <div className="settings-overlay">
          <div className="settings-modal setup-modal">
            <div className="settings-header">
              <span className="settings-title">welcome to agentdock</span>
            </div>
            <div className="settings-body">
              <div className="setup-content">
                {setupError && <div className="form-error" style={{ marginBottom: 12 }}>{setupError}</div>}
                {setupStep === "path" ? (
                  <>
                    <p className="setup-description">
                      Set the base directory where your repos live.
                      <span
                        className="setup-help-icon"
                        style={{ marginLeft: 6 }}
                        data-tooltip={"The parent folder that contains all your git repos.\nFor example, if your repos are at ~/projects/api and ~/projects/web, enter ~/projects."}
                      >i</span>
                    </p>
                    <label className="form-label">Base path</label>
                    <input
                      type="text"
                      className="form-input"
                      value={setupPath}
                      onChange={(e) => setSetupPath(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSetupScanRepos(); }}
                      autoFocus
                    />
                    <div className="setup-actions">
                      <button
                        className="btn btn-primary"
                        onClick={handleSetupScanRepos}
                        disabled={setupSaving || !setupPath.trim()}
                      >
                        {setupSaving ? "Scanning..." : "Continue"}
                      </button>
                    </div>
                  </>
                ) : setupStep === "hooks" ? (
                  <>
                    <p className="setup-description">
                      Let AgentDock see when an agent needs you.
                      <span
                        className="setup-help-icon"
                        style={{ marginLeft: 6 }}
                        data-tooltip={"Five lifecycle hooks in ~/.claude/settings.json.\nWithout them the queue reads the terminal to guess an agent's state, which is wrong often enough to matter."}
                      >i</span>
                    </p>
                    <p className="setup-subtle">
                      This is the difference between knowing an agent is blocked and finding out
                      ninety seconds later. It writes to <code>~/.claude/settings.json</code>,
                      outside AgentDock&rsquo;s own config, which is why it asks.
                    </p>

                    {setupHooks && (
                      <div className="settings-hook-list" style={{ marginTop: 12 }}>
                        {setupHooks.events.map((e) => {
                          const on = setupHooks.installed.includes(e.event);
                          return (
                            <div key={e.event} className="settings-hook-row">
                              <span className={`settings-hook-dot ${on ? "settings-hook-dot-on" : ""}`} />
                              <span className="settings-hook-event">{e.event}</span>
                              <span className="settings-hook-status">{e.status}</span>
                              <span className="settings-hook-means">{e.means}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="setup-actions">
                      {setupHooks?.ok ? (
                        <button className="btn btn-primary" onClick={() => setSetupStep("password")}>
                          Continue
                        </button>
                      ) : (
                        <button
                          className="btn btn-primary"
                          onClick={handleSetupInstallHooks}
                          disabled={setupHooksBusy}
                        >
                          {setupHooksBusy ? "Installing..." : "Install and continue"}
                        </button>
                      )}
                      <button className="btn" onClick={() => setSetupStep("password")}>
                        Skip
                      </button>
                    </div>
                    {setupHooks && !setupHooks.ok && (
                      <p className="setup-subtle" style={{ marginTop: 10 }}>
                        Skipping falls back to reading the terminal, which is what earlier versions did.
                      </p>
                    )}
                  </>
                ) : setupStep === "repos" ? (
                  <>
                    <p className="setup-description">
                      Found {discoveredRepos.length} git repo{discoveredRepos.length !== 1 ? "s" : ""} in <strong>{setupPath}</strong>. Select which ones to add:
                      <span
                        className="setup-help-icon"
                        style={{ marginLeft: 6 }}
                        data-tooltip={"Only selected repos will appear in agentdock.\nYou can add or remove repos later in Settings → Repositories."}
                      >i</span>
                    </p>
                    <div className="setup-repo-list">
                      {discoveredRepos.map((repo, i) => (
                        <label key={repo.alias} className="setup-repo-item">
                          <input
                            type="checkbox"
                            checked={repo.selected}
                            onChange={() => setDiscoveredRepos((prev) =>
                              prev.map((r, j) => j === i ? { ...r, selected: !r.selected } : r)
                            )}
                          />
                          <span className="setup-repo-name">{repo.alias}</span>
                          {repo.remote && (
                            <span className="setup-repo-remote">{repo.remote.replace(/^https?:\/\/github\.com\//, "")}</span>
                          )}
                        </label>
                      ))}
                    </div>
                    <div className="setup-actions">
                      <button
                        className="btn btn-primary"
                        onClick={handleSetupFinish}
                        disabled={setupSaving}
                      >
                        {setupSaving ? "Adding..." : `Add ${discoveredRepos.filter((r) => r.selected).length} repos`}
                      </button>
                      <button className="btn" onClick={() => setSetupStep("hooks")}>
                        Skip
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="setup-description">
                      Who can reach this?
                      <span
                        className="setup-help-icon"
                        style={{ marginLeft: 6 }}
                        data-tooltip={"AgentDock runs on your machine. The only question is whether anything else on your network can open it."}
                      >i</span>
                    </p>
                    <div className="setup-access">
                      {([
                        { id: "local" as const, title: "This machine only", detail: "Bound to localhost. Nothing else can connect, and no password is needed." },
                        { id: "network" as const, title: "Reachable on my network", detail: "So you can answer a blocked agent from your phone. A password is required — this is the whole reason the password exists." },
                      ]).map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className={`setup-access-card${setupAccess === a.id ? " setup-access-card-on" : ""}`}
                          onClick={() => setSetupAccess(a.id)}
                          aria-pressed={setupAccess === a.id}
                        >
                          <span className="setup-access-title">
                            <span className="setup-access-radio" />
                            {a.title}
                          </span>
                          <span className="setup-access-detail">{a.detail}</span>
                        </button>
                      ))}
                    </div>
                    {setupAccess === "network" && (
                    <>
                    <label className="form-label">Password</label>
                    <input
                      type="password"
                      className="form-input"
                      value={setupPassword}
                      onChange={(e) => setSetupPassword(e.target.value)}
                      placeholder="Leave blank to skip"
                      autoFocus
                    />
                    <label className="form-label" style={{ marginTop: 12 }}>Confirm password</label>
                    <input
                      type="password"
                      className="form-input"
                      value={setupPasswordConfirm}
                      onChange={(e) => setSetupPasswordConfirm(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && setupPassword) handleSetupSetPassword();
                        else if (e.key === "Enter") setShowSetup(false);
                      }}
                    />
                    </>
                    )}
                    <div className="setup-actions">
                      <button
                        className="btn btn-primary"
                        onClick={handleSetupSetPassword}
                        disabled={setupSaving || !setupPassword.trim()}
                      >
                        {setupSaving ? "Saving..." : "Set password"}
                      </button>
                      <button className="btn" onClick={() => setShowSetup(false)}>
                        Skip
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {editingSession && (
        <SessionEditModal
          session={editingSession}
          presets={metaPresets}
          onClose={() => setEditingSession(null)}
          onSave={async (meta, updatedPresets, newDisplayName) => {
            await updateSessionMeta(editingSession.name, meta);
            if (updatedPresets.length > 0) {
              await saveMetaPropertyPresets(updatedPresets);
              setMetaPresets([...updatedPresets]);
            }
            if (newDisplayName && newDisplayName !== editingSession.displayName) {
              const { name: renamed } = await renameSession(editingSession.name, newDisplayName);
              if (activeSession === editingSession.name) setActiveSession(renamed);
            }
            setEditingSession(null);
            refresh();
          }}
        />
      )}
      {tourActive && <TutorialOverlay onClose={() => setTourActive(false)} />}
      {!isMobile && (
        <nav className="app-rail" aria-label="This session">
          {RAIL.filter((r) => r.id !== "sub-agents" || hasChildren).map((r) => {
            const badge = railBadge(r.id);
            const on = fullSurface === r.id;
            return (
              <button
                key={r.id}
                className={`rail-btn${on ? " rail-btn-active" : ""}`}
                onClick={() => setFullSurface(on ? null : r.id)}
                title={`${r.label}${badge ? ` — ${badge}` : ""}`}
                aria-label={`${on ? "Close" : "Open"} ${r.label}${badge ? `, ${badge}` : ""}`}
                aria-pressed={on}
              >
                <Icon name={r.icon} size={18} />
                {badge && <span className={`rail-badge rail-badge-${r.id}`}>{badge}</span>}
              </button>
            );
          })}

          <span className="rail-sep" aria-hidden="true" />

          {/* Not a surface: this splits the terminal area rather than replacing
              it, so it sits after the separator and keeps its own state. */}
          <button
            className={`rail-btn${shells.length > 0 ? " rail-btn-active" : ""}`}
            onClick={addShell}
            disabled={!activeSession || shells.length >= 2 || shellBusy}
            title={
              shells.length >= 2
                ? "Two shells is the limit"
                : "Open a shell in this worktree"
            }
            aria-label="Open a shell in this worktree"
          >
            <Icon name="term" size={18} />
            {shells.length > 0 && <span className="rail-badge rail-badge-shell">{shells.length}</span>}
          </button>
        </nav>
      )}
    </div>

    {/* FAB: new session, only on session list */}
    {!mobileInSession && (
      <button className="session-fab" onClick={() => navigate("/create")} aria-label="New session">
        +
      </button>
    )}

    {/* Mobile: the phone's one job the desktop cannot do — unblock an agent
        while you are away from the machine. So blocked work leads, and the
        approve sheet is reachable without opening a terminal at all. */}
    {isMobile && !mobileInSession && !loading && sessions.length > 0 && (
      <div className="mobile-queue-host">
        <MobileQueue
          modeControl={modeSelect("mq-mode")}
          sectionOrder={mobileGrouping?.order}
          rows={sessions
            .filter((x) => !x.parentSession)
            .map((x) => ({
              name: x.name,
              displayName: x.displayName,
              bucket: queueBucket(x),
              age: timeAgo(x.created),
              repo: (x.path || "").split("/").filter(Boolean).pop() || "—",
              line: x.statusLine?.message || "",
              cta: queueBucket(x) === "blocked" ? "Answer" : queueBucket(x) === "review" ? "Review" : undefined,
              section: mobileGrouping?.byName.get(x.name),
            }))}
          onOpen={(name) => { setActiveSession(name); setMobileShowTerminal(true); }}
          onAction={(name, cta) => {
            setActiveSession(name);
            setMobileShowTerminal(true);
            // A phone shows surfaces through bottomTab, not fullSurface — the
            // latter only renders on desktop, so Review was a dead tap.
            if (cta === "Review") {
              setBottomTab("changes");
              setBottomMaximized(true);
            }
          }}
        />
      </div>
    )}

    {isMobile && mobileInSession && activeSessionInfo && isBlocked(activeSessionInfo) && !mobileApproveDismissed && (
      <MobileApprove
        displayName={activeSessionInfo.displayName}
        waited={timeAgo(activeSessionInfo.created)}
        question={activeSessionInfo.statusLine?.message || "This agent is waiting on you."}
        conflictWith={sharedWith?.session}
        onAllowOnce={() => { sendSessionInput(activeSession!, "1").catch(() => {}); setMobileApproveDismissed(true); }}
        onAllowSession={() => { sendSessionInput(activeSession!, "2").catch(() => {}); setMobileApproveDismissed(true); }}
        onDeny={(reason) => { sendSessionInput(activeSession!, reason || "no").catch(() => {}); setMobileApproveDismissed(true); }}
        onDismiss={() => setMobileApproveDismissed(true)}
      />
    )}

    {/* Bottom navigation bar. Only while a session is open: on the queue screen
        its one item was "Sessions", the screen you are already on, so the bar
        was 90px of nothing above the home indicator. */}
    {mobileInSession && (
      <nav className="mobile-bottom-nav">
        <button
          className="mobile-nav-item"
          onClick={() => setMobileShowTerminal(false)}
        >
          <span className="mobile-nav-icon"><Icon name="layers" size={20} /></span>
          <span className="mobile-nav-label">Sessions</span>
        </button>
        <button
          className={`mobile-nav-item ${!bottomTab ? "mobile-nav-item-active" : ""}`}
          onClick={() => { setBottomTab(null); setBottomMaximized(false); }}
        >
          <span className="mobile-nav-icon"><Icon name="term" size={20} /></span>
          <span className="mobile-nav-label">Terminal</span>
        </button>
        <button
          className={`mobile-nav-item ${bottomTab === "plan" ? "mobile-nav-item-active" : ""}`}
          onClick={() => { setBottomTab("plan"); setBottomMaximized(true); }}
        >
          <span className="mobile-nav-icon"><Icon name="plan" size={20} /></span>
          <span className="mobile-nav-label">Plan</span>
        </button>
        <button
          className={`mobile-nav-item ${bottomTab === "changes" ? "mobile-nav-item-active" : ""}`}
          onClick={() => { setBottomTab("changes"); setBottomMaximized(true); }}
        >
          <span className="mobile-nav-icon"><Icon name="diff" size={20} /></span>
          <span className="mobile-nav-label">Changes</span>
        </button>
        <button
          className={`mobile-nav-item ${bottomTab === "files" ? "mobile-nav-item-active" : ""}`}
          onClick={() => { setBottomTab("files"); setBottomMaximized(true); }}
        >
          <span className="mobile-nav-icon"><Icon name="folder" size={20} /></span>
          <span className="mobile-nav-label">Files</span>
        </button>
      </nav>
    )}
    {mruSwitcherVisible && createPortal(
      <div className="mru-switcher">
        {mruList.current
          .filter((s) => sessions.some((sess) => sess.name === s))
          .slice(0, 6)
          .map((name, idx) => {
            const sess = sessions.find((s) => s.name === name);
            const display = name.replace(/^claude-/, "");
            return (
              <div key={name} className={`mru-switcher-item${name === activeSession ? " mru-switcher-item-active" : ""}`}>
                <span className={`mru-switcher-status mru-status-${sess?.status ?? "unknown"}`} />
                <span className="mru-switcher-name">{display}</span>
                {idx === 0 && <span className="mru-switcher-badge">now</span>}
              </div>
            );
          })}
      </div>,
      document.body
    )}
    </>
  );
}
