import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { MetaSelect } from "../components/MetaSelect";
import { useNavigate, useSearchParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessions } from "../hooks/useSessions";
import { deleteSession, deleteAllSessions, fetchPlan, openInIterm, reorderSessions, fetchSettingsStatus, updateBasePath, scanRepos, addSettingsRepo, sendSessionInput, fetchGitRepos, fetchPreferences, updatePreferences, fetchMetaPropertyPresets, saveMetaPropertyPresets, updateSessionMeta, restoreSession, createSession } from "../api";
import { isDemo } from "../demo";
import { TutorialOverlay } from "../components/TutorialOverlay";
import { TerminalView } from "../components/TerminalView";
import { ChangesView } from "../components/ChangesView";
import { SubAgentsView } from "../components/SubAgentsView";
import { FileExplorer } from "../components/FileExplorer";
import type { FileExplorerHandle } from "../components/FileExplorer";
import { useMobileNav } from "../MobileNavContext";
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
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
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
    } finally {
      setRestoring(false);
    }
  };

  const displayStatus = getDisplayStatus(session);

  return (
    <div
      className={`session-row ${active ? "session-row-active" : ""} ${isChild ? "session-row-child" : ""} ${isChild && isLastChild ? "session-row-child-last" : ""} ${isDragging ? "dragging" : ""} ${isDragOver ? "drag-over" : ""} ${session.status === "stopped" ? "session-row-stopped" : ""}`}
      data-tutorial={dataTutorial}
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
            {restoring ? "restoring…" : "↺ restore"}
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
        <span className="session-row-path" title={session.path}>
          {session.path.replace(/^\/Users\/[^/]+\//, "~/")}
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
                  {restoring ? "Restoring…" : "↺ Restore session"}
                </button>
              )}
              <button className="session-row-menu-item danger" onClick={handleKill}>
                {session.status === "stopped" ? "Delete" : "Kill session"}
              </button>
            </div>
          )}
        </div>
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
  onSave: (meta: Record<string, string>, updatedPresets: MetaPropertyPreset[]) => void;
  onClose: () => void;
}) {
  const [meta, setMeta] = useState<Record<string, string>>(session.meta || {});

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return createPortal(
    <div className="settings-overlay" onClick={onClose}>
      <div className="session-edit-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">{session.displayName}</span>
          <button className="settings-close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="session-edit-body">
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
        <div className="session-edit-footer">
          <button className="btn btn-primary" onClick={() => onSave(meta, presets)}>Save</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
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
            data-tutorial="plan-comment-area"
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
  const [groupBy, setGroupBy] = useState<string>("");
  const [metaPresets, setMetaPresets] = useState<MetaPropertyPreset[]>([]);
  const [editingSession, setEditingSession] = useState<SessionInfo | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
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
      if (p.groupBy) setGroupBy(p.groupBy);
      if (p.collapsedGroups) setCollapsedGroups(new Set(p.collapsedGroups));
    });
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
  // mruList[0] = current session, mruList[1] = previous, etc.
  const mruList = useRef<string[]>([]);
  const [mruSwitcherVisible, setMruSwitcherVisible] = useState(false);
  const mruDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update MRU whenever active session changes
  useEffect(() => {
    if (!activeSession) return;
    mruList.current = [
      activeSession,
      ...mruList.current.filter((s) => s !== activeSession),
    ].slice(0, 8);
  }, [activeSession]);

  // Ctrl+` to cycle through MRU sessions
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== "`") return;
      e.preventDefault();
      const list = mruList.current.filter((s) => sessions.some((sess) => sess.name === s));
      if (list.length < 2) return;

      // Find current position in MRU and advance by 1
      const currentIdx = list.indexOf(activeSession ?? "");
      const nextIdx = (currentIdx + 1) % list.length;
      setActiveSession(list[nextIdx]);
      setMobileShowTerminal(true);

      // Show switcher popup, auto-dismiss after 1.5s of inactivity
      setMruSwitcherVisible(true);
      if (mruDismissTimer.current) clearTimeout(mruDismissTimer.current);
      mruDismissTimer.current = setTimeout(() => setMruSwitcherVisible(false), 1500);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeSession, sessions, setActiveSession]);

  // Cleanup dismiss timer on unmount
  useEffect(() => () => {
    if (mruDismissTimer.current) clearTimeout(mruDismissTimer.current);
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

  const groupedSessions = useMemo(() => {
    if (!groupBy) return null;
    const isStatusGroup = groupBy === "__status__";
    const groups: Record<string, typeof filteredSessions> = {};
    const ungrouped: typeof filteredSessions = [];
    for (const entry of filteredSessions) {
      if (entry.isChild) continue;
      let value: string;
      if (isStatusGroup) {
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
    await restoreSession(name);
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
    const liveSessions = sessions.filter((s) => s.status !== "stopped");
    const candidates = liveSessions.length > 0 ? liveSessions : sessions;
    if (!activeSession || !sessions.find((s) => s.name === activeSession)) {
      setActiveSession(candidates[0].name);
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

  return (
    <>
    <div className={`split-layout ${mobileInSession ? "mobile-show-terminal" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="split-sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">sessions</span>
          <div className="sidebar-actions">
            {sessions.length > 0 && (
              <button className="btn btn-stop btn-sm" onClick={handleStopAll}>
                kill --all
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => navigate("/create")} data-tutorial="new-session-btn">
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

        <div className="session-toolbar-row">
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
        <div className="session-group-by-wrap">
          <span className="session-group-by-icon">&#x25A4;</span>
          <select
            className="session-group-by-select"
            data-tutorial="group-by-select"
            value={groupBy}
            onChange={(e) => {
              setGroupBy(e.target.value);
              updatePreferences({ groupBy: e.target.value });
            }}
          >
            <option value="">No grouping</option>
            <option value="__status__">Status</option>
            {metaPresets.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
          {groupBy && groupedSessions && (
            <button
              className="session-group-collapse-all"
              onClick={() => {
                const allKeys = [...Object.keys(groupedSessions.groups)];
                if (groupedSessions.ungrouped.length > 0) allKeys.push("__ungrouped__");
                const allCollapsed = allKeys.every(k => collapsedGroups.has(k));
                const next = allCollapsed ? new Set<string>() : new Set(allKeys);
                setCollapsedGroups(next);
                updatePreferences({ collapsedGroups: [...next] });
              }}
              title={collapsedGroups.size > 0 ? "Expand all" : "Collapse all"}
            >
              {collapsedGroups.size > 0 ? "\u25B8\u25B8" : "\u25BE\u25BE"}
            </button>
          )}
        </div>
        </div>
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
                  className={`session-group ${groupBy !== "__status__" && dragIdx !== null ? "session-group-drop-target" : ""}`}
                  onDragOver={groupBy !== "__status__" ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } : undefined}
                  onDrop={groupBy !== "__status__" ? (e) => {
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
                    <span className="session-group-chevron">{collapsedGroups.has(value) ? "\u25B8" : "\u25BE"}</span>
                    <span className={`session-group-label ${groupBy === "__status__" ? `status-${value}` : ""}`}>{value}</span>
                    <span className="session-group-count">{entries.filter(e => !e.isChild).length}</span>
                    {groupBy !== "__status__" && (
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
                      onEditProps={metaPresets.length > 0 ? () => setEditingSession(session) : undefined}
                      onPinToHeader={() => handlePinToHeader(session)}
                      onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                      onForkSession={session.status !== "stopped" ? () => handleForkSession(session) : undefined}
                      dataTutorial={getDemoTutorialAttr(session)}
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
                    <span className="session-group-chevron">{collapsedGroups.has("__ungrouped__") ? "\u25B8" : "\u25BE"}</span>
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
                      onEditProps={metaPresets.length > 0 ? () => setEditingSession(session) : undefined}
                      onPinToHeader={() => handlePinToHeader(session)}
                      onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                      onForkSession={session.status !== "stopped" ? () => handleForkSession(session) : undefined}
                      dataTutorial={getDemoTutorialAttr(session)}
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
                draggable={!isChild}
                onDragStart={!isChild ? handleDragStart(parentIdx) : undefined}
                onDragOver={!isChild ? handleDragOver(parentIdx) : undefined}
                onDragEnd={!isChild ? handleDragEnd : undefined}
                onDrop={!isChild ? handleDrop(parentIdx) : undefined}
                isDragging={!isChild && dragIdx === parentIdx}
                isDragOver={!isChild && dragOverIdx === parentIdx && dragIdx !== parentIdx}
                onEditProps={metaPresets.length > 0 ? () => setEditingSession(session) : undefined}
                onPinToHeader={() => handlePinToHeader(session)}
                onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                dataTutorial={getDemoTutorialAttr(session)}
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
              <div className="split-terminal-pane" data-tutorial="terminal-pane" style={bottomTab ? { height: bottomMaximized ? "0%" : `${splitRatio * 100}%` } : undefined}>
                {activeSessionInfo?.status === "stopped" ? (
                  <div className="stopped-session-placeholder">
                    <div className="stopped-session-icon">◎</div>
                    <div className="stopped-session-title">{activeSessionInfo.displayName}</div>
                    <div className="stopped-session-desc">This session stopped (e.g. after a reboot).<br />Restore it to resume with full conversation history.</div>
                    <button
                      className="btn btn-primary stopped-session-restore-btn"
                      onClick={() => handleRestoreSession(activeSession)}
                    >
                      ↺ Restore Session
                    </button>
                  </div>
                ) : (!isMobile || mobileShowTerminal) && (
                  <TerminalView
                    key={activeSession}
                    sessionName={activeSession}
                    agentType={sessions.find((s) => s.name === activeSession)?.agentType}
                    onClosed={handleSessionClosed}
                    onAgentSwitched={refresh}
                    toolbarPortal={toolbarRef}
                    onSwipeBack={() => setMobileShowTerminal(false)}
                    onKeyboardVisibilityChange={setKbOpen}
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
                      data-tutorial="tab-plan"
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
                    data-tutorial="tab-changes"
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
                  <button
                    className={`main-tab ${bottomTab === "files" ? "main-tab-active" : ""}`}
                    onClick={() => setBottomTab(bottomTab === "files" ? null : "files")}
                  >
                    files
                  </button>
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
                <div className="split-bottom-pane" data-tutorial={bottomTab === "plan" ? "plan-content" : bottomTab === "changes" ? "changes-content" : undefined} style={{ height: bottomMaximized ? "100%" : `${(1 - splitRatio) * 100}%` }}>
                  {bottomTab === "changes" ? (
                    <ChangesView
                      key={activeSession}
                      sessionName={activeSession}
                      sessionPaths={activeSessionPaths}
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
                  ) : bottomTab === "files" ? (
                    <FileExplorer
                      key={activeSession}
                      ref={fileExplorerRef}
                      roots={activeSessionPaths}
                      onClose={() => {
                        setBottomTab(null);
                        setTimeout(() => window.dispatchEvent(new Event("agentdock-focus-terminal")), 50);
                      }}
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
      {editingSession && metaPresets.length > 0 && (
        <SessionEditModal
          session={editingSession}
          presets={metaPresets}
          onClose={() => setEditingSession(null)}
          onSave={async (meta, updatedPresets) => {
            await updateSessionMeta(editingSession.name, meta);
            await saveMetaPropertyPresets(updatedPresets);
            setMetaPresets([...updatedPresets]);
            setEditingSession(null);
            refresh();
          }}
        />
      )}
      {tourActive && <TutorialOverlay onClose={() => setTourActive(false)} />}
    </div>

    {/* FAB: new session, only on session list */}
    {!mobileInSession && (
      <button className="session-fab" onClick={() => navigate("/create")} aria-label="New session">
        +
      </button>
    )}

    {/* Bottom navigation bar */}
    <nav className="mobile-bottom-nav">
      <button
        className={`mobile-nav-item ${!mobileInSession ? "mobile-nav-item-active" : ""}`}
        onClick={() => setMobileShowTerminal(false)}
      >
        <span className="mobile-nav-icon">⊟</span>
        <span className="mobile-nav-label">Sessions</span>
      </button>
      {mobileInSession && (
        <>
          <button
            className={`mobile-nav-item ${!bottomTab ? "mobile-nav-item-active" : ""}`}
            onClick={() => { setBottomTab(null); setBottomMaximized(false); }}
          >
            <span className="mobile-nav-icon">▶</span>
            <span className="mobile-nav-label">Terminal</span>
          </button>
          <button
            className={`mobile-nav-item ${bottomTab === "plan" ? "mobile-nav-item-active" : ""}`}
            onClick={() => { setBottomTab("plan"); setBottomMaximized(true); }}
          >
            <span className="mobile-nav-icon">≡</span>
            <span className="mobile-nav-label">Plan</span>
          </button>
          <button
            className={`mobile-nav-item ${bottomTab === "changes" ? "mobile-nav-item-active" : ""}`}
            onClick={() => { setBottomTab("changes"); setBottomMaximized(true); }}
          >
            <span className="mobile-nav-icon">±</span>
            <span className="mobile-nav-label">Changes</span>
          </button>
          <button
            className={`mobile-nav-item ${bottomTab === "files" ? "mobile-nav-item-active" : ""}`}
            onClick={() => { setBottomTab("files"); setBottomMaximized(true); }}
          >
            <span className="mobile-nav-icon">⊞</span>
            <span className="mobile-nav-label">Files</span>
          </button>
        </>
      )}
    </nav>
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
