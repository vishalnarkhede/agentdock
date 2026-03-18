import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessions } from "../hooks/useSessions";
import { deleteSession, deleteAllSessions, fetchPlan, openInIterm, reorderSessions, fetchSettingsStatus, updateBasePath, scanRepos, addSettingsRepo, sendSessionInput } from "../api";
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
    try {
      await deleteSession(session.name);
      onStopped();
    } catch (err: any) {
      console.error("Failed to delete session:", err);
    }
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
        {session.agentType && session.agentType !== "claude" && (
          <span className="session-row-agent" title={`Agent: ${session.agentType}`}>
            {session.agentType === "cursor" ? "Cursor" : session.agentType}
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

interface PlanComment {
  id: string;
  selectedText: string;
  comment: string;
}

function PlanView({ sessionName, viewMode }: { sessionName: string; viewMode: "rendered" | "raw" }) {
  const [plan, setPlan] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  // Selection-based commenting
  const [selectedText, setSelectedText] = useState("");
  const [showCommentBtn, setShowCommentBtn] = useState<{ top: number; left: number } | null>(null);
  const [commentBox, setCommentBox] = useState<{ top: number; text: string } | null>(null);
  const [comment, setComment] = useState("");
  const [pendingComments, setPendingComments] = useState<PlanComment[]>([]);
  const [batchSending, setBatchSending] = useState(false);
  const [batchExpanded, setBatchExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const savedRange = useRef<Range | null>(null);

  const loadPlan = useCallback(() => {
    fetchPlan(sessionName).then((p) => {
      setPlan(p);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, [sessionName]);

  useEffect(() => {
    setLoading(true);
    loadPlan();
    const interval = setInterval(loadPlan, 5000);
    return () => clearInterval(interval);
  }, [loadPlan]);

  // Listen for plan-download event from parent dropdown menu
  useEffect(() => {
    const handler = () => handleDownload();
    window.addEventListener("plan-download", handler);
    return () => window.removeEventListener("plan-download", handler);
  }, [plan, sessionName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (commentBox && commentRef.current) commentRef.current.focus();
  }, [commentBox]);

  // On mouseup inside plan content, check if there's a text selection
  const handleContentMouseUp = useCallback(() => {
    // Small delay to let the browser finalize the selection
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !contentRef.current) return;
      const text = sel.toString().trim();
      if (!text) return;

      const range = sel.getRangeAt(0);
      if (!contentRef.current.contains(range.commonAncestorContainer)) return;

      setSelectedText(text);
      savedRange.current = range.cloneRange();
      const rect = range.getBoundingClientRect();
      const containerRect = contentRef.current.getBoundingClientRect();
      setShowCommentBtn({
        top: rect.bottom - containerRect.top + contentRef.current.scrollTop + 4,
        left: rect.left - containerRect.left + rect.width / 2 - 50,
      });
    });
  }, []);

  // Clicking anywhere in content without a selection dismisses the button
  const handleContentMouseDown = useCallback(() => {
    if (showCommentBtn && !commentBox) {
      setShowCommentBtn(null);
      setSelectedText("");
    }
  }, [showCommentBtn, commentBox]);

  const handleOpenCommentBox = () => {
    if (!showCommentBtn || !selectedText) return;
    setCommentBox({ top: showCommentBtn.top + 32, text: selectedText });
    setShowCommentBtn(null);
    setComment("");
    // Apply CSS Custom Highlight to keep selection visible
    if (savedRange.current && typeof Highlight !== "undefined" && CSS.highlights) {
      const hl = new Highlight(savedRange.current);
      CSS.highlights.set("plan-comment-selection", hl);
    }
  };

  const clearHighlight = useCallback(() => {
    if (typeof CSS !== "undefined" && CSS.highlights) {
      CSS.highlights.delete("plan-comment-selection");
    }
    savedRange.current = null;
  }, []);

  const handleAddComment = () => {
    if (!comment.trim() || !commentBox) return;
    setPendingComments(prev => [...prev, {
      id: crypto.randomUUID(),
      selectedText: commentBox.text,
      comment: comment.trim(),
    }]);
    setComment("");
    setCommentBox(null);
    setSelectedText("");
    clearHighlight();
    window.getSelection()?.removeAllRanges();
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
    if (e.key === "Escape") {
      setComment("");
      setCommentBox(null);
      clearHighlight();
    }
  };

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

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setSending(true);
    try {
      const planFile = `~/.config/agentdock/plans/${sessionName}.md`;
      const planRef = plan ? `First read the plan at ${planFile} for full context, then:\n\n` : "";
      await sendSessionInput(sessionName, planRef + message.trim());
      setMessage("");
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setSending(false);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSendAll = async () => {
    if (pendingComments.length === 0) return;
    setBatchSending(true);
    try {
      const planFile = `~/.config/agentdock/plans/${sessionName}.md`;
      const planRef = plan ? `First read the plan at ${planFile} for full context, then address these comments:\n\n` : "";
      const msg = planRef + pendingComments.map(c =>
        `Regarding this part of the plan:\n\`\`\`\n${c.selectedText}\n\`\`\`\n${c.comment}`
      ).join("\n\n---\n\n");
      await sendSessionInput(sessionName, msg);
      setPendingComments([]);
    } catch (err) {
      console.error("Failed to send comments:", err);
    } finally {
      setBatchSending(false);
    }
  };

  if (loading) {
    return <div className="plan-view"><div className="plan-loading">loading plan...</div></div>;
  }

  return (
    <div className="plan-view">
      {plan ? (
        <>
          <div
            className="plan-content"
            ref={contentRef}
            style={{ position: "relative" }}
            onMouseUp={handleContentMouseUp}
            onMouseDown={handleContentMouseDown}
          >
            {viewMode === "rendered" ? (
              <Markdown remarkPlugins={[remarkGfm]}>{plan}</Markdown>
            ) : (
              <pre className="plan-raw">{plan}</pre>
            )}

            {showCommentBtn && !commentBox && (
              <button
                className="plan-add-comment-btn"
                style={{ top: showCommentBtn.top, left: showCommentBtn.left }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={handleOpenCommentBox}
              >
                + add comment
              </button>
            )}

            {commentBox && (
              <div
                className="plan-comment-popover"
                style={{ top: commentBox.top, left: 0, right: 0 }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="plan-comment-context">{commentBox.text}</div>
                <textarea
                  ref={commentRef}
                  className="diff-comment-input"
                  placeholder="Add a comment... (Enter to add, Esc to cancel)"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={handleCommentKeyDown}
                  rows={2}
                />
                <div className="diff-comment-actions">
                  <button className="btn btn-sm" onClick={() => { setCommentBox(null); setComment(""); clearHighlight(); }}>
                    cancel
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleAddComment}
                    disabled={!comment.trim()}
                  >
                    add comment
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="plan-empty">no plan yet — ask the agent to create one</div>
      )}

      {pendingComments.length > 0 && (
        <div className="comment-batch-bar">
          <div className="comment-batch-summary" onClick={() => setBatchExpanded(!batchExpanded)}>
            <span className="comment-batch-count">
              {pendingComments.length} comment{pendingComments.length !== 1 ? "s" : ""}
            </span>
            <div className="comment-batch-actions">
              <span className="comment-batch-expand">{batchExpanded ? "\u25BE" : "\u25B8"}</span>
              <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setPendingComments([]); }}>
                clear
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={(e) => { e.stopPropagation(); handleSendAll(); }}
                disabled={batchSending}
              >
                {batchSending ? "sending..." : "send all to claude"}
              </button>
            </div>
          </div>
          {batchExpanded && (
            <div className="comment-batch-list">
              {pendingComments.map((c) => (
                <div key={c.id} className="comment-batch-item">
                  <div className="comment-batch-item-header">
                    <span className="comment-batch-item-file">plan</span>
                    <button
                      className="comment-batch-item-remove"
                      onClick={() => setPendingComments(prev => prev.filter(p => p.id !== c.id))}
                    >
                      &times;
                    </button>
                  </div>
                  <pre className="comment-batch-item-code">{c.selectedText}</pre>
                  <div className="comment-batch-item-text">{c.comment}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="plan-input-bar">
        <textarea
          className="plan-input"
          placeholder="Send a message to the agent..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleInputKeyDown}
          rows={2}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSend}
          disabled={!message.trim() || sending}
        >
          {sending ? "sending..." : "send"}
        </button>
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

  // Bottom pane (plan/changes/sub-agents) split with terminal
  const [bottomTab, setBottomTab] = useState<"plan" | "changes" | "sub-agents" | null>(null);
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
  const [setupStep, setSetupStep] = useState<"path" | "repos">("path");
  const [setupPath, setSetupPath] = useState("~/projects");
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
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
    setSetupError(null);
    try {
      await updateBasePath(setupPath);
      const repos = await scanRepos();
      if (repos.length > 0) {
        setDiscoveredRepos(repos.map((r) => ({ ...r, selected: true })));
        setSetupStep("repos");
      } else {
        setShowSetup(false);
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
      setShowSetup(false);
    } catch (err: any) {
      setSetupError(err?.message || "Failed to save repos");
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

  // Check if active session has children or is a child (for sub-agents tab & breadcrumb)
  const activeSessionInfo = sessions.find((s) => s.name === activeSession);
  const hasChildren = (activeSessionInfo?.children?.length ?? 0) > 0;
  const parentSessionInfo = activeSessionInfo?.parentSession
    ? sessions.find((s) => s.name === activeSessionInfo.parentSession)
    : null;

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

        {sessions.length > 0 && (
          <div className="session-search-wrap">
            <input
              ref={sessionSearchRef}
              type="text"
              className="session-search"
              placeholder="Search sessions... (⌘K)"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSessionSearch("");
                  sessionSearchRef.current?.blur();
                }
              }}
            />
          </div>
        )}
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
              <div className="main-tabs-toolbar" ref={toolbarRef} />
            </div>
            <div className="main-content main-content-split" ref={splitContainerRef}>
              <div className="split-terminal-pane" style={bottomTab ? { height: bottomMaximized ? "0%" : `${splitRatio * 100}%` } : undefined}>
                {(!isMobile || mobileShowTerminal) && (
                  <TerminalView
                    key={activeSession}
                    sessionName={activeSession}
                    agentType={sessions.find((s) => s.name === activeSession)?.agentType}
                    onClosed={handleSessionClosed}
                    onAgentSwitched={refresh}
                    toolbarPortal={toolbarRef}
                  />
                )}
              </div>
              <div className={`split-bottom-bar${bottomTab ? " split-bottom-bar-open" : ""}`}>
                <div
                  className="split-resize-handle"
                  onMouseDown={handleSplitMouseDown}
                />
                <div className="split-bottom-tabs">
                  <div className="plan-tab-wrap" ref={planMenuRef}>
                    <button
                      className={`main-tab ${bottomTab === "plan" ? "main-tab-active" : ""}`}
                      onClick={() => setBottomTab(bottomTab === "plan" ? null : "plan")}
                    >
                      plan
                    </button>
                    {bottomTab === "plan" && (
                      <button
                        className="plan-tab-menu-btn"
                        onClick={() => setPlanMenuOpen(!planMenuOpen)}
                      >
                        &#x22EE;
                      </button>
                    )}
                    {planMenuOpen && (
                      <div className="plan-tab-menu">
                        <button
                          className="plan-tab-menu-item"
                          onClick={() => {
                            setPlanViewMode(planViewMode === "rendered" ? "raw" : "rendered");
                            setPlanMenuOpen(false);
                          }}
                        >
                          {planViewMode === "rendered" ? "View raw" : "View rendered"}
                        </button>
                        <button
                          className="plan-tab-menu-item"
                          onClick={() => {
                            // Trigger download via a custom event the PlanView listens to
                            window.dispatchEvent(new Event("plan-download"));
                            setPlanMenuOpen(false);
                          }}
                        >
                          Download
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    className={`main-tab ${bottomTab === "changes" ? "main-tab-active" : ""}`}
                    onClick={() => setBottomTab(bottomTab === "changes" ? null : "changes")}
                  >
                    changes
                  </button>
                  {hasChildren && (
                    <button
                      className={`main-tab main-tab-sub ${bottomTab === "sub-agents" ? "main-tab-active" : ""}`}
                      onClick={() => setBottomTab(bottomTab === "sub-agents" ? null : "sub-agents")}
                    >
                      sub-agents
                      <span className="tab-badge">{activeSessionInfo?.children?.length}</span>
                    </button>
                  )}
                  {bottomTab && (
                    <button
                      className="main-tab split-maximize-btn"
                      onClick={() => setBottomMaximized(!bottomMaximized)}
                      title={bottomMaximized ? "Restore split" : "Maximize"}
                    >
                      {bottomMaximized ? "\u25BD" : "\u25B3"}
                    </button>
                  )}
                </div>
              </div>
              {bottomTab && (
                <div className="split-bottom-pane" style={{ height: bottomMaximized ? "100%" : `${(1 - splitRatio) * 100}%` }}>
                  {bottomTab === "changes" ? (
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
                      onCommentsSent={() => setBottomTab(null)}
                    />
                  ) : bottomTab === "sub-agents" && hasChildren ? (
                    <SubAgentsView
                      key={activeSession}
                      parentSession={activeSession}
                      sessions={sessions}
                      onSelectChild={(childName) => {
                        setActiveSession(childName);
                        setBottomTab(null);
                        setMobileShowTerminal(true);
                      }}
                      onRefresh={refresh}
                    />
                  ) : (
                    <PlanView key={activeSession} sessionName={activeSession} viewMode={planViewMode} />
                  )}
                </div>
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
                {setupError && <div className="form-error" style={{ marginBottom: 12 }}>{setupError}</div>}
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
