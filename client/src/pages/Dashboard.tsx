import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessions } from "../hooks/useSessions";
import { deleteSession, deleteAllSessions, fetchPlan, openInIterm, reorderSessions, fetchSettingsStatus, updateBasePath, scanRepos, addSettingsRepo } from "../api";
import { TerminalView } from "../components/TerminalView";
import { ChangesView } from "../components/ChangesView";
import { SubAgentsView } from "../components/SubAgentsView";
import { useMobileNav } from "../MobileNavContext";
import type { SessionInfo } from "../types";

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

function getDisplayStatus(session: SessionInfo): string {
  return session.statusLine?.type
    ?? (session.status === "shell" ? "done" : session.status === "unknown" ? "" : session.status);
}

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
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const handleKill = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Kill session "${session.displayName}"?`)) return;
    setMenuOpen(false);
    await deleteSession(session.name);
    onStopped();
  };

  const displayStatus = getDisplayStatus(session);

  return (
    <div
      className={`session-row ${active ? "session-row-active" : ""} ${isChild ? "session-row-child" : ""} ${isChild && isLastChild ? "session-row-child-last" : ""} ${isDragging ? "dragging" : ""} ${isDragOver ? "drag-over" : ""}`}
      onClick={onSelect}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
    >
      <div className="session-row-main">
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
            <span className="children-badge-icon">{childrenExpanded ? "\u25BE" : "\u25B8"}</span>
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
        {displayStatus && (
          <span className={`session-row-status status-${displayStatus}`}>
            {displayStatus}
          </span>
        )}
        <span className="session-row-age">{timeAgo(session.created)}</span>
      </div>
      {session.statusLine && (
        <div className={`session-row-statusline status-${session.statusLine.type}`}>
          {session.statusLine.message}
        </div>
      )}
      <div className="session-row-meta">
        <span className="session-row-path" title={session.path}>
          {session.path.replace(/^\/Users\/[^/]+\//, "~/")}
        </span>
        {session.agentType && (
          <span className="session-row-agent" title={`Agent: ${session.agentType}`}>
            {session.agentType === "claude" ? "Claude" : "Cursor"}
          </span>
        )}
        <div className="session-row-menu-wrap" ref={menuRef}>
          <button
            className="session-row-menu-btn"
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            aria-label="Session actions"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="session-row-menu">
              {onTogglePin && (
                <button className="session-row-menu-item" onClick={(e) => { e.stopPropagation(); onTogglePin(); setMenuOpen(false); }}>
                  {pinned ? "Unpin" : "Pin to top"}
                </button>
              )}
              <button className="session-row-menu-item" onClick={handleCopy}>Copy name</button>
              <button className="session-row-menu-item" onClick={handleCopyPath}>Copy path</button>
              <button className="session-row-menu-item" onClick={handleOpenIterm}>Open in iTerm</button>
              <button className="session-row-menu-item danger" onClick={handleKill}>Kill session</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanView({ sessionName }: { sessionName: string }) {
  const [plan, setPlan] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");

  const loadPlan = useCallback(() => {
    fetchPlan(sessionName).then((p) => {
      setPlan(p);
      setLoading(false);
    });
  }, [sessionName]);

  useEffect(() => {
    setLoading(true);
    loadPlan();
    // Poll for plan updates every 5s
    const interval = setInterval(loadPlan, 5000);
    return () => clearInterval(interval);
  }, [loadPlan]);

  const handleDownload = () => {
    if (!plan) return;
    const filename = prompt("Save as:", `${sessionName}.md`);
    if (!filename) return;
    const blob = new Blob([plan], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.endsWith(".md") ? filename : `${filename}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="plan-view"><div className="plan-loading">loading plan...</div></div>;
  }

  if (!plan) {
    return (
      <div className="plan-view">
        <div className="plan-empty">no plan yet — ask the agent to create one</div>
      </div>
    );
  }

  return (
    <div className="plan-view">
      <div className="plan-toolbar">
        <div className="plan-toolbar-toggles">
          <button
            className={`btn btn-sm changes-view-toggle${viewMode === "rendered" ? " changes-view-toggle-active" : ""}`}
            onClick={() => setViewMode("rendered")}
          >
            rendered
          </button>
          <button
            className={`btn btn-sm changes-view-toggle${viewMode === "raw" ? " changes-view-toggle-active" : ""}`}
            onClick={() => setViewMode("raw")}
          >
            raw
          </button>
        </div>
        <button className="btn btn-sm" onClick={handleDownload}>
          download
        </button>
      </div>
      <div className="plan-content">
        {viewMode === "rendered" ? (
          <Markdown remarkPlugins={[remarkGfm]}>{plan}</Markdown>
        ) : (
          <pre className="plan-raw">{plan}</pre>
        )}
      </div>
    </div>
  );
}

export function Dashboard() {
  const { sessions, loading, refresh } = useSessions();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mobileNav = useMobileNav();
  const [mobileShowTerminal, setMobileShowTerminal] = useState(false);
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
  const activeTab = mobileNav?.activeTab ?? "terminal";
  const setActiveTab = mobileNav?.setActiveTab ?? (() => {});

  // First-run setup
  const [showSetup, setShowSetup] = useState(false);
  const [setupStep, setSetupStep] = useState<"path" | "repos">("path");
  const [setupPath, setSetupPath] = useState("~/projects");
  const [setupSaving, setSetupSaving] = useState(false);
  const [discoveredRepos, setDiscoveredRepos] = useState<{ alias: string; path: string; remote?: string; selected: boolean }[]>([]);

  useEffect(() => {
    fetchSettingsStatus().then((status) => {
      if (status.needsSetup) {
        setSetupPath(status.basePath);
        setShowSetup(true);
      }
    }).catch(() => {});
  }, []);

  const handleSetupScanRepos = async () => {
    setSetupSaving(true);
    try {
      await updateBasePath(setupPath);
      const repos = await scanRepos();
      if (repos.length > 0) {
        setDiscoveredRepos(repos.map((r) => ({ ...r, selected: true })));
        setSetupStep("repos");
      } else {
        setShowSetup(false);
      }
    } catch {
      // ignore
    } finally {
      setSetupSaving(false);
    }
  };

  const handleSetupFinish = async () => {
    setSetupSaving(true);
    try {
      const selected = discoveredRepos.filter((r) => r.selected);
      await Promise.all(selected.map((r) => addSettingsRepo({ alias: r.alias, path: r.path, remote: r.remote })));
      setShowSetup(false);
    } catch {
      // ignore
    } finally {
      setSetupSaving(false);
    }
  };

  const toolbarRef = useRef<HTMLDivElement>(null);
  const activeSession = searchParams.get("session");
  const setActiveSession = useCallback((name: string | null) => {
    setSearchParams(name ? { session: name } : {}, { replace: true });
  }, [setSearchParams]);

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
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("agentdock-pinned-sessions");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const togglePin = useCallback((name: string) => {
    setPinnedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      localStorage.setItem("agentdock-pinned-sessions", JSON.stringify([...next]));
      return next;
    });
  }, []);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

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
    const sortedParents = [...pinnedParents, ...unpinnedParents];

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
  }, [sessions, collapsedParents, pinnedSessions]);

  // Check if active session has children or is a child (for sub-agents tab & breadcrumb)
  const activeSessionInfo = sessions.find((s) => s.name === activeSession);
  const hasChildren = (activeSessionInfo?.children?.length ?? 0) > 0;
  const parentSessionInfo = activeSessionInfo?.parentSession
    ? sessions.find((s) => s.name === activeSessionInfo.parentSession)
    : null;

  const handleStopAll = async () => {
    if (!confirm("Stop all sessions?")) return;
    await deleteAllSessions();
    setActiveSession(null);
    refresh();
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

  // Auto-select first session if none selected, or fix stale selection
  useEffect(() => {
    if (loading) return; // don't touch URL param while sessions are loading
    if (!sessions.length) {
      if (activeSession) setActiveSession(null);
      return;
    }
    if (!activeSession || !sessions.find((s) => s.name === activeSession)) {
      setActiveSession(sessions[0].name);
    }
  }, [sessions, loading, activeSession, setActiveSession]);

  // On load with session param, show terminal on mobile
  useEffect(() => {
    if (activeSession && isMobile) {
      setMobileShowTerminal(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync mobile nav context
  const { setInSession, setGoBack } = mobileNav ?? {};
  useEffect(() => {
    setInSession?.(!!(mobileShowTerminal && activeSession));
  }, [mobileShowTerminal, activeSession, setInSession]);

  useEffect(() => {
    setGoBack?.(() => setMobileShowTerminal(false));
  }, [setGoBack]);

  return (
    <div className={`split-layout ${mobileShowTerminal && activeSession ? "mobile-show-terminal" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="split-sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">sessions</span>
          <div className="sidebar-actions">
            {sessions.length > 0 && (
              <button className="btn btn-stop btn-sm" onClick={handleStopAll}>
                kill --all
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => navigate("/create")}>
              + new
            </button>
            <button
              className="btn btn-sm sidebar-collapse-btn"
              onClick={() => setSidebarCollapsed(true)}
              title="Collapse sidebar"
            >
              &laquo;
            </button>
          </div>
        </div>

        <div className="session-list">
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
          ) : (
            orderedSessions.map(({ session, isChild, isLastChild, childrenSummary, childrenExpanded, parentIdx }) => (
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
                onDragStart={!isChild ? handleDragStart(parentIdx) : undefined}
                onDragOver={!isChild ? handleDragOver(parentIdx) : undefined}
                onDragEnd={!isChild ? handleDragEnd : undefined}
                onDrop={!isChild ? handleDrop(parentIdx) : undefined}
                isDragging={!isChild && dragIdx === parentIdx}
                isDragOver={!isChild && dragOverIdx === parentIdx && dragIdx !== parentIdx}
              />
            ))
          )}
        </div>
      </div>

      <div className="split-main">
        {activeSession ? (
          <>
            <div className="main-tabs">
              {sidebarCollapsed && (
                <button
                  className="main-tab sidebar-expand-btn"
                  onClick={() => setSidebarCollapsed(false)}
                  title="Expand sidebar"
                >
                  &raquo;
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
              <button
                className={`main-tab ${activeTab === "terminal" ? "main-tab-active" : ""}`}
                onClick={() => setActiveTab("terminal")}
              >
                terminal
              </button>
              <button
                className={`main-tab ${activeTab === "plan" ? "main-tab-active" : ""}`}
                onClick={() => setActiveTab("plan")}
              >
                plan
              </button>
              <button
                className={`main-tab ${activeTab === "changes" ? "main-tab-active" : ""}`}
                onClick={() => setActiveTab("changes")}
              >
                changes
              </button>
              {hasChildren && (
                <button
                  className={`main-tab main-tab-sub ${activeTab === "sub-agents" ? "main-tab-active" : ""}`}
                  onClick={() => setActiveTab("sub-agents")}
                >
                  sub-agents
                  <span className="tab-badge">{activeSessionInfo?.children?.length}</span>
                </button>
              )}
              <div className="main-tabs-toolbar" ref={toolbarRef} />
            </div>
            <div className="main-content">
              {activeTab === "terminal" ? (
                !isMobile || mobileShowTerminal ? (
                  <TerminalView
                    key={activeSession}
                    sessionName={activeSession}
                    agentType={sessions.find((s) => s.name === activeSession)?.agentType}
                    onClosed={handleSessionClosed}
                    onAgentSwitched={refresh}
                    toolbarPortal={toolbarRef}
                  />
                ) : null
              ) : activeTab === "changes" ? (
                <ChangesView
                  key={activeSession}
                  sessionName={activeSession}
                  sessionPaths={(() => {
                    const s = sessions.find((s) => s.name === activeSession);
                    if (s?.worktrees && s.worktrees.length > 0) {
                      return s.worktrees.map((wt) => wt.wtDir);
                    }
                    return s?.path ? [s.path] : [];
                  })()}
                  onCommentsSent={() => setActiveTab("terminal")}
                />
              ) : activeTab === "sub-agents" && hasChildren ? (
                <SubAgentsView
                  key={activeSession}
                  parentSession={activeSession}
                  sessions={sessions}
                  onSelectChild={(childName) => {
                    setActiveSession(childName);
                    setActiveTab("terminal");
                    setMobileShowTerminal(true);
                  }}
                  onRefresh={refresh}
                />
              ) : (
                <PlanView key={activeSession} sessionName={activeSession} />
              )}
            </div>
          </>
        ) : (
          <div className="split-empty">
            <span className="split-empty-text">select a session</span>
          </div>
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
                {setupStep === "path" ? (
                  <>
                    <p className="setup-description">
                      Set the base directory where your repos live.
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
                ) : (
                  <>
                    <p className="setup-description">
                      Found {discoveredRepos.length} git repo{discoveredRepos.length !== 1 ? "s" : ""} in <strong>{setupPath}</strong>. Select which ones to add:
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
    </div>
  );
}
