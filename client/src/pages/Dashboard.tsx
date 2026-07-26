import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { MetaSelect } from "../components/MetaSelect";
import { useSearchParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessions } from "../hooks/useSessions";
import { deleteSession, deleteAllSessions, fetchPlan, openTerminal, reorderSessions, fetchSettingsStatus, updateBasePath, scanRepos, addSettingsRepo, sendSessionInput, fetchGitRepos, fetchGitSummary, fetchPreferences, updatePreferences, fetchMetaPropertyPresets, saveMetaPropertyPresets, updateSessionMeta, restoreSession, createSession, fetchRepos, fetchSettingsHealth, setPassword, type GitDiffStats } from "../api";
import { isDemo } from "../demo";
import { agentTypeLabel, worktreeClause } from "../session-messages";
import { NEW_AGENT_SHORTCUT } from "../shortcuts";
import { TutorialOverlay } from "../components/TutorialOverlay";
import { TerminalView } from "../components/TerminalView";
import { ChangesView } from "../components/ChangesView";
import { SubAgentsView } from "../components/SubAgentsView";
import { FileExplorer } from "../components/FileExplorer";
import { ShellView } from "../components/ShellView";
import { GitLogView } from "../components/GitLogView";
import { WorktreesView } from "../components/WorktreesView";
import { ConfirmActionModal, type ConfirmAction } from "../components/ConfirmActionModal";
import { CreateSessionModal } from "./CreateSession";
import type { FileExplorerHandle } from "../components/FileExplorer";
import { useMobileNav } from "../MobileNavContext";
import { useAuth } from "../hooks/useAuth";
import type { SessionInfo, MetaPropertyPreset, QuickLaunch, AgentType } from "../types";

function timeAgo(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

const NEW_SESSION_FOCUS_TIMEOUT_MS = 10_000;

// Block capitals rather than the old three-row box-drawing font: at that height "c"
// (┌─┐│  └─┘) and "k" (┬┌─├┴┐┴ ┴) were near-unreadable. Five rows gives each letter
// a distinct shape, and the wider gap separates the two words. 55 columns, uniform.
const ASCII_LOGO = `
 ███   ████ █████ █   █ █████   ████   ███   ████ █   █
█   █ █     █     ██  █   █     █   █ █   █ █     █  █
█████ █  ██ ████  █ █ █   █     █   █ █   █ █     ███
█   █ █   █ █     █  ██   █     █   █ █   █ █     █  █
█   █  ████ █████ █   █   █     ████   ███   ████ █   █
`;

/**
 * Which repo(s) an agent is working in.
 *
 * Grouping on the worktree directory would put every agent in its own group, since
 * each isolated agent gets a fresh one — the repo is the axis that actually gathers
 * related work. Agents with no worktree (a general chat) return "" and fall into
 * Ungrouped rather than inventing a bucket for them.
 */
function repoLabel(session: SessionInfo): string {
  const repos = session.worktrees
    .map((wt) => wt.repoPath.replace(/\/+$/, "").split("/").pop() || "")
    .filter(Boolean);
  const unique = [...new Set(repos)];
  // Multi-repo agents get one combined group; listing them under each repo would
  // mean rendering the same session more than once.
  return unique.join(" + ");
}

function getDemoTutorialAttr(session: SessionInfo): string | undefined {
  if (!isDemo()) return undefined;
  if (session.name === "acme-api-auth-fix") return "session-auth-fix";
  if (getDisplayStatus(session) === "working" && session.name === "acme-api-auth-fix") return "session-working";
  if (session.name === "acme-api-rate-limiter") return "session-done";
  if (session.name === "infra-k8s-migration/api-routes") return "session-input";
  if (session.name === "infra-k8s-migration") return "session-subagents";
  if (session.status === "stopped") return "session-stopped";
  if (getDisplayStatus(session) === "working") return "session-working";
  return undefined;
}

function getDisplayStatus(session: SessionInfo): string {
  if (session.status === "stopped") return "stopped";
  if (session.statusLine?.type) return session.statusLine.type;
  if (session.status === "shell") return "inactive";
  if (session.status === "unknown") return "sleeping";
  return session.status;
}

function getStatusPriority(session: SessionInfo): number {
  const status = getDisplayStatus(session) || session.status || "unknown";
  switch (status) {
    case "input":
    case "waiting":
      return 0;
    case "error":
      return 1;
    case "done":
      return 2;
    case "working":
      return 3;
    case "background":
      return 4;
    case "sleeping":
      return 5;
    case "inactive":
    case "shell":
      return 6;
    case "unknown":
      return 7;
    case "stopped":
      return 8;
    default:
      return 8;
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case "working":
      return "🤖";
    case "waiting":
    case "input":
      return "💬";
    case "done":
      return "✅";
    case "background":
      return "🔄";
    case "error":
      return "⚠️";
    case "sleeping":
      return "🌙";
    case "inactive":
    case "shell":
      return "⏸️";
    case "stopped":
      return "⏹️";
    default:
      return "•";
  }
}

function statusTitle(status: string): string {
  switch (status) {
    case "working":
      return "Working";
    case "waiting":
    case "input":
      return "Waiting for input";
    case "done":
      return "Done";
    case "background":
      return "Running in background";
    case "error":
      return "Error";
    case "sleeping":
      return "Sleeping";
    case "inactive":
    case "shell":
      return "Inactive";
    case "stopped":
      return "Stopped";
    default:
      return "Unknown";
  }
}

function sortSessionsByPickupPriority(sessions: SessionInfo[]): SessionInfo[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const priorityDiff = getStatusPriority(a.session) - getStatusPriority(b.session);
      return priorityDiff || a.index - b.index;
    })
    .map(({ session }) => session);
}

function groupLabel(value: string, groupBy: string): string {
  if (groupBy !== "__status__") return value;
  return value.replace(/(^|-)([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`);
}

interface SessionGitTarget {
  path: string;
  name: string;
  branch: string | null;
  workingTree: GitDiffStats;
}

interface SessionGitSeed {
  path: string;
  name: string;
}

function basenameFromPath(path: string): string {
  return path.replace(/\/$/, "").split("/").filter(Boolean).pop() || path;
}

function sessionGitSeeds(session: SessionInfo): SessionGitSeed[] {
  const seeds = session.worktrees?.length
    ? session.worktrees.map((worktree) => ({
        path: worktree.wtDir,
        name: basenameFromPath(worktree.repoPath || worktree.wtDir),
      }))
    : [{ path: session.path, name: basenameFromPath(session.path) }];

  const seen = new Set<string>();
  const unique: SessionGitSeed[] = [];
  for (const seed of seeds) {
    if (!seed.path || seen.has(seed.path)) continue;
    seen.add(seed.path);
    unique.push(seed);
  }
  return unique.slice(0, 4);
}

function addDiffStats(total: GitDiffStats, item: GitDiffStats): GitDiffStats {
  return {
    files: total.files + item.files,
    additions: total.additions + item.additions,
    deletions: total.deletions + item.deletions,
  };
}

function hasDiffStats(stats: GitDiffStats | null): stats is GitDiffStats {
  return Boolean(stats && (stats.files > 0 || stats.additions > 0 || stats.deletions > 0));
}

function cleanBranchName(branch: string | null): string | null {
  if (!branch) return null;
  return branch.replace(/^refs\/heads\//, "");
}

function SessionGitMeta({ session }: { session: SessionInfo }) {
  const seeds = useMemo(() => sessionGitSeeds(session), [session.path, session.worktrees]);
  const pathsKey = seeds.map((seed) => `${seed.name}:${seed.path}`).join("||");
  const [targets, setTargets] = useState<SessionGitTarget[]>(() =>
    seeds.map((seed) => ({
      path: seed.path,
      name: seed.name,
      branch: null,
      workingTree: { files: 0, additions: 0, deletions: 0 },
    })),
  );

  useEffect(() => {
    const fallbackTargets = seeds.map((seed) => ({
      path: seed.path,
      name: seed.name,
      branch: null,
      workingTree: { files: 0, additions: 0, deletions: 0 },
    }));

    if (!pathsKey) {
      setTargets([]);
      return;
    }

    let cancelled = false;
    setTargets(fallbackTargets);
    const load = () => {
      Promise.all(
        seeds.map((seed) =>
          fetchGitSummary(seed.path)
            .then((summary) => ({
              path: seed.path,
              name: seed.name,
              branch: cleanBranchName(summary.branch),
              workingTree: summary.workingTree,
            }))
            .catch(() => ({
              path: seed.path,
              name: seed.name,
              branch: null,
              workingTree: { files: 0, additions: 0, deletions: 0 },
            })),
        ),
      ).then((items) => {
        if (!cancelled) setTargets(items);
      });
    };

    load();
    const interval = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pathsKey]);

  const primary = targets[0];
  if (!primary) return null;

  const stats = targets.reduce((total, target) => addDiffStats(total, target.workingTree), { files: 0, additions: 0, deletions: 0 });
  const branch = cleanBranchName(primary.branch);
  const title = targets
    .map((target) => `${target.name}${target.branch ? ` (${target.branch})` : ""}\n${target.path}`)
    .join("\n\n");

  return (
    <>
      <span className="session-row-target" title={title}>
        <span className="session-row-target-name">{primary.name}</span>
        {branch && <span className="branch-label session-row-target-branch">{branch}</span>}
        {targets.length > 1 && <span className="session-row-target-extra">+{targets.length - 1}</span>}
      </span>
      {hasDiffStats(stats) && (
        <span className="session-row-diff-chip" title="Uncommitted file diff">
          <span className="session-row-diff-icon" aria-hidden="true" />
          <span className="session-row-diff-files">{stats.files} file{stats.files !== 1 ? "s" : ""}</span>
          {stats.additions > 0 && <span className="diff-stat-add">+{stats.additions}</span>}
          {stats.deletions > 0 && <span className="diff-stat-del">-{stats.deletions}</span>}
        </span>
      )}
    </>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onRequestStop,
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
  onSaveQuickLaunch,
  onRestore,
  onForkSession,
  dataTutorial,
  ordinal,
  selectionMode,
  selected,
  onToggleSelect,
}: {
  session: SessionInfo;
  active: boolean;
  onSelect: () => void;
  onRequestStop?: (session: SessionInfo) => void;
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
  onSaveQuickLaunch?: () => void;
  onRestore?: () => Promise<void>;
  onForkSession?: () => void;
  dataTutorial?: string;
  ordinal?: number;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
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

  const handleOpenTerminal = (e: React.MouseEvent) => {
    e.stopPropagation();
    openTerminal(session.name);
    setMenuOpen(false);
  };

  const handleEditProps = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onEditProps?.();
  };

  const handleKill = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onRequestStop?.(session);
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
  // Runs in a pane the user owns. Every action that would write to it is withheld —
  // the server refuses them too, this just avoids offering a button that only errors.
  const isExternal = Boolean(session.external);

  return (
    <div
      className={`session-row ${active && !selectionMode ? "session-row-active" : ""} ${selected ? "session-row-selected" : ""} ${isChild ? "session-row-child" : ""} ${isChild && isLastChild ? "session-row-child-last" : ""} ${isDragging ? "dragging" : ""} ${isDragOver ? "drag-over" : ""} ${session.status === "stopped" ? "session-row-stopped" : ""} ${menuOpen ? "session-row-menu-open" : ""}`}
      data-tutorial={dataTutorial}
      onClick={selectionMode ? (e) => { e.stopPropagation(); onToggleSelect?.(); } : onSelect}
      draggable={selectionMode ? false : draggable}
      onDragStart={selectionMode ? undefined : onDragStart}
      onDragOver={selectionMode ? undefined : onDragOver}
      onDragEnd={selectionMode ? undefined : onDragEnd}
      onDrop={selectionMode ? undefined : onDrop}
    >
      <div className="session-row-main">
        {selectionMode && !isExternal && (
          <span className={`session-row-select-check${selected ? " session-row-select-check-on" : ""}`} />
        )}
        {isChild && (
          <span className="session-row-tree-connector">
            {isLastChild ? "\u2514\u2500" : "\u251C\u2500"}
          </span>
        )}
        {ordinal && <span className="session-row-number" aria-label={`Agent ${ordinal}`}>{ordinal}</span>}
        <span
          className={`session-row-status-icon status-${displayStatus || session.status}`}
          title={statusTitle(displayStatus || session.status)}
          aria-label={statusTitle(displayStatus || session.status)}
        >
          {statusIcon(displayStatus || session.status)}
        </span>
        {pinned && <span className="session-row-pin" title="Pinned">&#x25C6;</span>}
        <span className="session-row-name">
          {session.displayName}
        </span>
        {isExternal && (
          <span
            className="session-row-external-badge"
            title={`Running in your tmux pane ${session.externalTarget ?? ""} — read-only, and status is inferred from the terminal`}
          >
            external
          </span>
        )}
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
        {session.status === "stopped" && onRestore && (
          <button
            className={`session-row-restore-btn ${restoring ? "restoring" : ""}`}
            onClick={handleRestore}
            disabled={restoring}
            title="Restore agent"
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
        <SessionGitMeta session={session} />
        {session.agentType && session.agentType !== "claude" && (
          <span className="session-row-agent" title={`Agent type: ${agentTypeLabel(session.agentType)}`}>
            {agentTypeLabel(session.agentType)}
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
            onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
            aria-label="Agent actions"
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
              {onEditProps && !isExternal && (
                <button className="session-row-menu-item" onClick={handleEditProps}>Edit properties</button>
              )}
              {onSaveQuickLaunch && !isExternal && (
                <button className="session-row-menu-item" onClick={(e) => { e.stopPropagation(); onSaveQuickLaunch(); setMenuOpen(false); }}>Save as quick launch</button>
              )}
              {onForkSession && (
                <button className="session-row-menu-item" onClick={(e) => { e.stopPropagation(); onForkSession(); setMenuOpen(false); }}>
                  + New agent here
                </button>
              )}
              <button className="session-row-menu-item" onClick={handleCopy}>Copy name</button>
              <button className="session-row-menu-item" onClick={handleCopyPath}>Copy path</button>
              {session.status !== "stopped" && !isExternal && (
                <button className="session-row-menu-item" onClick={handleOpenTerminal}>Open terminal</button>
              )}
              {session.status === "stopped" && onRestore && (
                <button className="session-row-menu-item" onClick={handleRestore} disabled={restoring}>
                  {restoring ? "Restoring…" : "↺ Restore agent"}
                </button>
              )}
              {isExternal ? (
                <div className="session-row-menu-note">
                  Read-only — Agentdock did not start this agent
                </div>
              ) : (
                <button className="session-row-menu-item danger" onClick={handleKill}>
                  {session.status === "stopped" ? "Delete" : "Stop agent"}
                </button>
              )}
            </div>
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


function makeBlockRenderer(
  tag: "p" | "h1" | "h2" | "h3" | "h4",
  onGutterMouseDown: (e: React.MouseEvent<HTMLButtonElement>) => void,
  onGutterTouchStart: (e: React.TouchEvent<HTMLButtonElement>) => void,
  onBlockMouseEnter: (e: React.MouseEvent<HTMLElement>) => void,
) {
  const BlockTag = tag as React.ElementType;
  return ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <div className="plan-block-wrap" onMouseEnter={onBlockMouseEnter}>
      <div className="plan-block-gutter">
        <button
          className="plan-gutter-btn"
          tabIndex={-1}
          aria-label="Add comment to this section"
          onMouseDown={onGutterMouseDown}
          onTouchStart={onGutterTouchStart}
        >
          +
        </button>
      </div>
      <BlockTag {...props}>{children}</BlockTag>
    </div>
  );
}

function makeLiRenderer(
  onGutterMouseDown: (e: React.MouseEvent<HTMLButtonElement>) => void,
  onGutterTouchStart: (e: React.TouchEvent<HTMLButtonElement>) => void,
  onBlockMouseEnter: (e: React.MouseEvent<HTMLElement>) => void,
) {
  return ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
    <li
      {...props}
      className={`plan-li-wrap${props.className ? " " + props.className : ""}`}
      onMouseEnter={onBlockMouseEnter as React.MouseEventHandler<HTMLLIElement>}
    >
      <span className="plan-li-gutter">
        <button
          className="plan-gutter-btn"
          tabIndex={-1}
          aria-label="Add comment to this item"
          onMouseDown={onGutterMouseDown}
          onTouchStart={onGutterTouchStart}
        >
          +
        </button>
      </span>
      {children}
    </li>
  );
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
  // Block drag-select state (gutter "+" drag)
  const [blockSel, setBlockSel] = useState<{ start: number; end: number } | null>(null);
  const [blockComment, setBlockComment] = useState("");
  const [blockCommentTop, setBlockCommentTop] = useState<number | null>(null);
  const blockCommentRef = useRef<HTMLTextAreaElement>(null);
  const isBlockDraggingRef = useRef(false);
  const blockDragStartRef = useRef(-1);

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

  // Assign data-block-idx to each selectable block after plan renders
  useLayoutEffect(() => {
    if (!contentRef.current) return;
    contentRef.current.querySelectorAll<HTMLElement>(".plan-block-wrap, .plan-li-wrap").forEach((el, i) => {
      el.dataset.blockIdx = String(i);
    });
  }, [plan, viewMode]);

  // Apply/remove selection highlight class
  useEffect(() => {
    if (!contentRef.current) return;
    const blocks = contentRef.current.querySelectorAll<HTMLElement>(".plan-block-wrap, .plan-li-wrap");
    const selMin = blockSel ? Math.min(blockSel.start, blockSel.end) : -1;
    const selMax = blockSel ? Math.max(blockSel.start, blockSel.end) : -1;
    blocks.forEach((el, i) => el.classList.toggle("plan-block-selected", i >= selMin && i <= selMax));
  }, [blockSel]);

  // Global mouseup/touchend: finalize drag → show inline comment box
  useEffect(() => {
    const onUp = () => {
      if (!isBlockDraggingRef.current) return;
      isBlockDraggingRef.current = false;
      if (!contentRef.current || !blockSel) return;
      const blocks = contentRef.current.querySelectorAll<HTMLElement>(".plan-block-wrap, .plan-li-wrap");
      const lastIdx = Math.min(Math.max(blockSel.start, blockSel.end), blocks.length - 1);
      const lastEl = blocks[lastIdx];
      if (!lastEl) return;
      const lastRect = lastEl.getBoundingClientRect();
      const contentRect = contentRef.current.getBoundingClientRect();
      const top = lastRect.bottom - contentRect.top + contentRef.current.scrollTop + 4;
      setBlockCommentTop(top);
      setBlockComment("");
      setTimeout(() => {
        blockCommentRef.current?.focus();
        blockCommentRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 50);
    };
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
    return () => { window.removeEventListener("mouseup", onUp); window.removeEventListener("touchend", onUp); };
  }, [blockSel]);

  // Native touchmove to extend selection on touch (passive:false to allow preventDefault)
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onTouchMove = (e: TouchEvent) => {
      if (!isBlockDraggingRef.current) return;
      e.preventDefault();
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
      const wrap = el?.closest<HTMLElement>("[data-block-idx]");
      if (!wrap) return;
      const idx = parseInt(wrap.dataset.blockIdx ?? "-1", 10);
      if (idx >= 0) setBlockSel(prev => prev ? { start: blockDragStartRef.current, end: idx } : null);
    };
    content.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => content.removeEventListener("touchmove", onTouchMove);
  }, [plan]);

  // On mouseup inside plan content, check if there's a text selection
  const handleContentMouseUp = useCallback(() => {
    if (isBlockDraggingRef.current) return; // block drag takes precedence
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

  // Clicking anywhere in content without a selection dismisses buttons/comment boxes
  const handleContentMouseDown = useCallback(() => {
    if (showCommentBtn && !commentBox) {
      setShowCommentBtn(null);
      setSelectedText("");
    }
    // Clear block selection if clicking in content area (gutter stops propagation)
    if (blockCommentTop !== null) {
      setBlockCommentTop(null);
      setBlockSel(null);
      setBlockComment("");
    }
  }, [showCommentBtn, commentBox, blockCommentTop]);

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

  const handleGutterMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const wrap = e.currentTarget.closest<HTMLElement>("[data-block-idx]");
    if (!wrap) return;
    const idx = parseInt(wrap.dataset.blockIdx ?? "0", 10);
    isBlockDraggingRef.current = true;
    blockDragStartRef.current = idx;
    setBlockSel({ start: idx, end: idx });
    setBlockCommentTop(null);
    setBlockComment("");
    setCommentBox(null);
    setShowCommentBtn(null);
    clearHighlight();
  }, [clearHighlight]);

  const handleGutterTouchStart = useCallback((e: React.TouchEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const wrap = e.currentTarget.closest<HTMLElement>("[data-block-idx]");
    if (!wrap) return;
    const idx = parseInt(wrap.dataset.blockIdx ?? "0", 10);
    isBlockDraggingRef.current = true;
    blockDragStartRef.current = idx;
    setBlockSel({ start: idx, end: idx });
    setBlockCommentTop(null);
    setBlockComment("");
  }, []);

  const handleBlockMouseEnter = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!isBlockDraggingRef.current) return;
    const wrap = e.currentTarget;
    const idx = parseInt(wrap.dataset.blockIdx ?? "-1", 10);
    if (idx >= 0) setBlockSel(prev => prev ? { start: blockDragStartRef.current, end: idx } : null);
  }, []);

  const handleAddBlockComment = useCallback(() => {
    if (!blockComment.trim() || !blockSel || !contentRef.current) return;
    const blocks = contentRef.current.querySelectorAll<HTMLElement>(".plan-block-wrap, .plan-li-wrap");
    const selMin = Math.min(blockSel.start, blockSel.end);
    const selMax = Math.max(blockSel.start, blockSel.end);
    const selectedText = Array.from(blocks).slice(selMin, selMax + 1)
      .map(el => el.innerText.trim()).filter(Boolean).join("\n");
    setPendingComments(prev => [...prev, { id: crypto.randomUUID(), selectedText, comment: blockComment.trim() }]);
    setBlockComment("");
    setBlockCommentTop(null);
    setBlockSel(null);
    blocks.forEach(el => el.classList.remove("plan-block-selected"));
  }, [blockComment, blockSel]);

  const handleBlockCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAddBlockComment(); }
    if (e.key === "Escape") { setBlockCommentTop(null); setBlockSel(null); setBlockComment(""); }
  };

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

  const markdownComponents = useMemo(() => ({
    p:  makeBlockRenderer("p",  handleGutterMouseDown, handleGutterTouchStart, handleBlockMouseEnter),
    h1: makeBlockRenderer("h1", handleGutterMouseDown, handleGutterTouchStart, handleBlockMouseEnter),
    h2: makeBlockRenderer("h2", handleGutterMouseDown, handleGutterTouchStart, handleBlockMouseEnter),
    h3: makeBlockRenderer("h3", handleGutterMouseDown, handleGutterTouchStart, handleBlockMouseEnter),
    h4: makeBlockRenderer("h4", handleGutterMouseDown, handleGutterTouchStart, handleBlockMouseEnter),
    li: makeLiRenderer(handleGutterMouseDown, handleGutterTouchStart, handleBlockMouseEnter),
  }), [handleGutterMouseDown, handleGutterTouchStart, handleBlockMouseEnter]);

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
              <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{plan}</Markdown>
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

            {blockCommentTop !== null && blockSel && (
              <div
                className="plan-block-comment-box"
                style={{ top: blockCommentTop }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <textarea
                  ref={blockCommentRef}
                  className="diff-comment-input"
                  placeholder="Add a comment... (Enter to add, Esc to cancel)"
                  value={blockComment}
                  onChange={(e) => setBlockComment(e.target.value)}
                  onKeyDown={handleBlockCommentKeyDown}
                  rows={2}
                />
                <div className="diff-comment-actions">
                  <button className="btn btn-sm" onClick={() => { setBlockCommentTop(null); setBlockSel(null); setBlockComment(""); }}>
                    cancel
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={handleAddBlockComment} disabled={!blockComment.trim()}>
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
  const { login: authLogin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const mobileNav = useMobileNav();
  const [mobileShowTerminal, setMobileShowTerminal] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"agents" | "worktrees">("agents");
  const [quickLaunches, setQuickLaunches] = useState<QuickLaunch[]>([]);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const activeTab = mobileNav?.activeTab ?? "terminal";
  const setActiveTab = mobileNav?.setActiveTab ?? (() => {});

  // Bottom pane (plan/review/sub-agents) split with terminal
  const [bottomTab, setBottomTab] = useState<"plan" | "changes" | "git-log" | "sub-agents" | "files" | "shell" | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.5); // 0..1, fraction for terminal
  const [bottomMaximized, setBottomMaximized] = useState(false);
  const [splitFullscreen, setSplitFullscreen] = useState(false);
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

  const handleFullscreenPanelShortcut = useCallback(() => {
    if (!bottomTab) return false;
    if (bottomMaximized) {
      setBottomMaximized(false);
      return true;
    }
    setBottomTab(null);
    return true;
  }, [bottomMaximized, bottomTab]);

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
  const [setupStep, setSetupStep] = useState<"path" | "repos" | "password">("path");
  const [setupPath, setSetupPath] = useState("~/projects");
  const [setupSaving, setSetupSaving] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [discoveredRepos, setDiscoveredRepos] = useState<{ alias: string; path: string; remote?: string; selected: boolean }[]>([]);
  const [setupPassword, setSetupPassword] = useState("");
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
        setSetupStep("password");
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
      setSetupStep("password");
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
  const pendingActiveSessionRef = useRef<{ name: string; expiresAt: number } | null>(null);
  const activeSession = searchParams.get("session");
  const setActiveSession = useCallback((name: string | null) => {
    setSearchParams(name ? { session: name } : {}, { replace: true });
  }, [setSearchParams]);

  const focusCreatedSession = useCallback(async (sessionName: string) => {
    pendingActiveSessionRef.current = {
      name: sessionName,
      expiresAt: Date.now() + NEW_SESSION_FOCUS_TIMEOUT_MS,
    };
    setWorkspaceTab("agents");
    setActiveSession(sessionName);
    setMobileShowTerminal(true);
    window.dispatchEvent(new CustomEvent("agentdock-mobile-show-terminal"));
    await refresh();
  }, [refresh, setActiveSession]);

  const loadQuickLaunches = useCallback(() => {
    fetchPreferences().then((p) => setQuickLaunches(p.quickLaunches || []));
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
      const { sessions: created } = await createSession({
        targets: ql.targets,
        name: ql.sessionName,
        dangerouslySkipPermissions: true,
        agentType: (ql.agentType as any) || "claude",
        grouped: true,
      });
      if (created?.[0]) {
        await focusCreatedSession(created[0]);
      }
    } catch (err) {
      console.error("Failed to launch quick agent:", err);
    } finally {
      setLaunchingId(null);
    }
  }, [focusCreatedSession, launchingId]);

  const removeQuickLaunch = useCallback(async (id: string) => {
    const updated = quickLaunches.filter((q) => q.id !== id);
    setQuickLaunches(updated);
    await updatePreferences({ quickLaunches: updated });
  }, [quickLaunches]);

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
      if (p.groupBy) setGroupBy(p.groupBy);
      if (p.collapsedGroups) setCollapsedGroups(new Set(p.collapsedGroups));
      if (p.mruSessions) mruList.current = p.mruSessions;
    });
    fetchMetaPropertyPresets().then(setMetaPresets);
    const handler = () => fetchMetaPropertyPresets().then(setMetaPresets);
    window.addEventListener("agentdock-meta-presets-changed", handler);
    return () => window.removeEventListener("agentdock-meta-presets-changed", handler);
  }, []);

  const togglePin = useCallback((name: string) => {
    setPinnedSessions((prev) => {
      const alreadyPinned = prev.has(name);
      const ordered = alreadyPinned
        ? [...prev].filter((pinned) => pinned !== name)
        : [name, ...prev].filter((pinned, idx, arr) => arr.indexOf(pinned) === idx);
      updatePreferences({ pinnedSessions: ordered });
      return new Set(ordered);
    });
  }, []);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const [newAgentModal, setNewAgentModal] = useState<{
    initialMetaValues: Record<string, string>;
    initialTargetMode?: "checkout" | "general";
    initialSessionName?: string;
    initialTargets?: string[];
    initialAgentType?: AgentType;
  } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const openNewAgent = useCallback((
    initialMetaValues: Record<string, string> = {},
    options: { initialTargetMode?: "checkout" | "general"; initialSessionName?: string; initialTargets?: string[]; initialAgentType?: AgentType } = {},
  ) => {
    setWorkspaceTab("agents");
    setMobileShowTerminal(false);
    setNewAgentModal({ initialMetaValues, ...options });
  }, []);

  const closeNewAgent = useCallback(() => {
    setNewAgentModal(null);
  }, []);

  const handleNewAgentCreated = useCallback((sessionName: string) => {
    setNewAgentModal(null);
    void focusCreatedSession(sessionName);
  }, [focusCreatedSession]);

  // Cmd+Shift+A creates a new agent from Agents or Worktrees.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.key.toLowerCase() !== "a") return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT") return;
      e.preventDefault();
      openNewAgent();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openNewAgent]);

  // Cmd+K focuses the search box for the active workspace tab.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (workspaceTab === "worktrees") {
          window.dispatchEvent(new Event("agentdock-focus-worktree-search"));
          return;
        }
        sessionSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspaceTab]);

  // Option/Alt+W jumps to Worktrees and focuses its search.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== "w") return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      e.preventDefault();
      setWorkspaceTab("worktrees");
      setMobileShowTerminal(false);
      window.setTimeout(() => {
        window.dispatchEvent(new Event("agentdock-focus-worktree-search"));
      }, 0);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Cmd+P to open explorer and focus file search
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
      if (newAgentModal) return;
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      setBottomTab((prev) => (prev ? null : prev));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [newAgentModal]);

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
  }, [activeSession]);

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
      setWorkspaceTab("agents");
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
  }, []);

  // Build ordered session list: pinned first, then parents, then their children indented below
  const orderedSessions = useMemo(() => {
    const childNames = new Set<string>();
    for (const s of sessions) {
      if (s.parentSession) childNames.add(s.name);
    }

    const parents = sessions.filter((s) => !childNames.has(s.name));
    const parentsByName = new Map(parents.map((session) => [session.name, session]));
    const pinnedParents = [...pinnedSessions]
      .map((name) => parentsByName.get(name))
      .filter(Boolean) as SessionInfo[];
    const unpinnedParents = parents.filter((s) => !pinnedSessions.has(s.name));
    const sortedParents = [
      ...pinnedParents,
      ...sortSessionsByPickupPriority(unpinnedParents),
    ];

    const result: { session: SessionInfo; isChild: boolean; isLastChild: boolean; childrenSummary?: { total: number; working: number; done: number; error: number }; childrenExpanded: boolean; parentIdx: number }[] = [];
    let pIdx = 0;
    for (const session of sortedParents) {

      // Compute children summary for parents
      const childList = (session.children || [])
        .map((name) => sessions.find((s) => s.name === name))
        .filter(Boolean) as SessionInfo[];
      const childrenSummary = childList.length > 0 ? {
        total: childList.length,
        working: childList.filter((c) => getDisplayStatus(c) === "working").length,
        done: childList.filter((c) => getDisplayStatus(c) === "done").length,
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

  // "__"-prefixed groupings are computed from the session itself rather than stored on
  // it, so they can't be reassigned by dragging or seeded into the create form.
  const isDerivedGroup = groupBy.startsWith("__");

  const groupedSessions = useMemo(() => {
    if (!groupBy) return null;
    const isStatusGroup = groupBy === "__status__";
    const isRepoGroup = groupBy === "__repo__";
    const groups: Record<string, typeof filteredSessions> = {};
    const ungrouped: typeof filteredSessions = [];
    for (const entry of filteredSessions) {
      if (entry.isChild) continue;
      let value: string;
      if (isStatusGroup) {
        value = getDisplayStatus(entry.session) || entry.session.status || "unknown";
      } else if (isRepoGroup) {
        value = repoLabel(entry.session);
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
      const order = ["input", "waiting", "error", "done", "working", "background", "sleeping", "inactive", "shell", "unknown", "stopped"];
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
    if (isRepoGroup) {
      // Repo names carry no inherent order, so alphabetical keeps the list stable
      // as agents come and go.
      const sorted: Record<string, typeof filteredSessions> = {};
      for (const key of Object.keys(groups).sort((a, b) => a.localeCompare(b))) {
        sorted[key] = groups[key];
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

  const handleKillSelected = async () => {
    if (selectedSessions.size === 0) return;
    const selectedNames = [...selectedSessions];
    const selected = sessions.filter((s) => selectedSessions.has(s.name));
    const liveCount = selected.filter((s) => s.status !== "stopped").length;
    const stoppedCount = selected.length - liveCount;
    const title = liveCount > 0 && stoppedCount > 0
      ? "Stop or delete selected agents?"
      : liveCount > 0 ? "Stop selected agents?" : "Delete selected agents?";
    const details = [
      liveCount > 0 ? `${liveCount} active agent${liveCount === 1 ? "" : "s"} will have their terminal closed.` : "",
      stoppedCount > 0 ? `${stoppedCount} stopped agent${stoppedCount === 1 ? "" : "s"} will be removed from AgentDock.` : "",
      worktreeClause(selected, true).trim(),
    ].filter(Boolean);

    setConfirmAction({
      title,
      message: `${selected.length} selected agent${selected.length === 1 ? "" : "s"} will be updated.`,
      details,
      confirmLabel: liveCount > 0 && stoppedCount > 0 ? "Stop/delete" : liveCount > 0 ? "Stop selected" : "Delete selected",
      busyLabel: liveCount > 0 && stoppedCount > 0 ? "Updating..." : liveCount > 0 ? "Stopping..." : "Deleting...",
      tone: "danger",
      onConfirm: async () => {
        await Promise.all(selectedNames.map(name => deleteSession(name).catch(() => {})));
        if (activeSession && selectedNames.includes(activeSession)) {
          const remaining = sessions.filter(s => !selectedNames.includes(s.name));
          setActiveSession(remaining.length > 0 ? remaining[0].name : null);
        }
        setSelectedSessions(new Set());
        setSelectionMode(false);
        refresh();
      },
    });
  };

  const handleExitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedSessions(new Set());
  };

  // External agents can't be stopped from here, so they stay out of bulk selection
  // entirely — otherwise "All" would arm a Stop that silently fails for some of them.
  const selectableSessions = useMemo(() => sessions.filter((s) => !s.external), [sessions]);

  const handleToggleSelectAll = () => {
    if (selectedSessions.size === selectableSessions.length) {
      setSelectedSessions(new Set());
    } else {
      setSelectedSessions(new Set(selectableSessions.map(s => s.name)));
    }
  };

  const handleStopAll = async () => {
    const active = sessions.filter((s) => s.status !== "stopped" && !s.external);
    if (active.length === 0) return;
    setConfirmAction({
      title: "Stop all active agents?",
      message: `${active.length} active agent${active.length === 1 ? "" : "s"} will be stopped.`,
      details: [
        "Each terminal will close immediately.",
        worktreeClause(active, true).trim(),
      ].filter(Boolean),
      confirmLabel: "Stop all",
      busyLabel: "Stopping...",
      tone: "danger",
      onConfirm: async () => {
        await deleteAllSessions();
        setActiveSession(null);
        refresh();
      },
    });
  };

  const handleStopped = useCallback((stoppedName?: string) => {
    if (activeSession && (!stoppedName || activeSession === stoppedName)) {
      const remaining = sessions.filter((s) => s.name !== (stoppedName || activeSession));
      if (remaining.length > 0) {
        setActiveSession(remaining[0].name);
      } else {
        setActiveSession(null);
      }
    }
    refresh();
  }, [activeSession, refresh, sessions, setActiveSession]);

  const requestStopSession = useCallback((session: SessionInfo) => {
    const stopped = session.status === "stopped";
    setConfirmAction({
      title: stopped ? "Delete stopped agent?" : "Stop agent?",
      message: stopped
        ? `Delete "${session.displayName}" from AgentDock?`
        : `Stop "${session.displayName}"?`,
      details: stopped
        ? ["This removes saved AgentDock metadata for the stopped agent.", "The git branch is not deleted."]
        : ["The terminal will close immediately.", worktreeClause([session]).trim()].filter(Boolean),
      confirmLabel: stopped ? "Delete agent" : "Stop agent",
      busyLabel: stopped ? "Deleting..." : "Stopping...",
      tone: "danger",
      onConfirm: async () => {
        await deleteSession(session.name);
        handleStopped(session.name);
      },
    });
  }, [handleStopped]);

  const handleSaveQuickLaunch = useCallback(async (session: SessionInfo) => {
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
    setQuickLaunches(updated);
    await updatePreferences({ quickLaunches: updated });
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
    const normalizePath = (path: string) => path.replace(/\/+$/, "");
    const sessionPaths = [
      ...(session.worktrees || []).map((wt) => wt.wtDir),
      session.path,
    ].filter(Boolean).map(normalizePath);
    const sourcePaths = (session.worktrees || []).map((wt) => wt.repoPath).filter(Boolean).map(normalizePath);
    let initialTargets: string[] = [];

    try {
      const repos = await fetchRepos();
      const aliasByPath = new Map(repos.map((repo) => [normalizePath(repo.path), repo.alias]));
      initialTargets = [...new Set(
        [...sessionPaths, ...sourcePaths]
          .map((path) => aliasByPath.get(path))
          .filter((alias): alias is string => Boolean(alias)),
      )];
    } catch (err) {
      console.error("Failed to resolve session target:", err);
    }

    openNewAgent({}, {
      initialTargetMode: sessionPaths.length > 0 ? "checkout" : "general",
      initialTargets,
      initialAgentType: session.agentType || "claude",
    });
  }, [openNewAgent]);

  // Auto-select first session if none selected, or fix stale selection
  useEffect(() => {
    if (loading) return; // don't touch URL param while sessions are loading

    const pending = pendingActiveSessionRef.current;
    if (pending) {
      const pendingExists = sessions.some((s) => s.name === pending.name);
      if (pendingExists) {
        pendingActiveSessionRef.current = null;
        if (activeSession !== pending.name) setActiveSession(pending.name);
        return;
      }
      const activeExists = activeSession ? sessions.some((s) => s.name === activeSession) : false;
      if (activeSession && activeSession !== pending.name && activeExists) {
        pendingActiveSessionRef.current = null;
        return;
      }
      if (Date.now() < pending.expiresAt) {
        if (activeSession !== pending.name) setActiveSession(pending.name);
        return;
      }
      pendingActiveSessionRef.current = null;
    }

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
    const handler = () => {
      setWorkspaceTab("agents");
      if (isMobile) setMobileShowTerminal(true);
    };
    window.addEventListener("agentdock-mobile-show-terminal", handler);
    return () => window.removeEventListener("agentdock-mobile-show-terminal", handler);
  }, [isMobile]);

  // Sync mobile nav context
  const { setInSession, setGoBack, setSessionTitle } = mobileNav ?? {};
  useEffect(() => {
    setInSession?.(!!(workspaceTab === "agents" && mobileShowTerminal && activeSession));
  }, [workspaceTab, mobileShowTerminal, activeSession, setInSession]);

  useEffect(() => {
    setGoBack?.(() => setMobileShowTerminal(false));
  }, [setGoBack]);

  const mobileInSession = workspaceTab === "agents" && mobileShowTerminal && !!activeSession;

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
    <div className={`dashboard-shell ${mobileInSession ? "dashboard-shell-mobile-session" : ""}`}>
      <div className="dashboard-tabs" role="tablist" aria-label="Dashboard sections">
        <button
          className={`dashboard-tab ${workspaceTab === "agents" ? "dashboard-tab-active" : ""}`}
          onClick={() => setWorkspaceTab("agents")}
        >
          <span>Agents</span>
        </button>
        <button
          className={`dashboard-tab ${workspaceTab === "worktrees" ? "dashboard-tab-active" : ""}`}
          onClick={() => { setWorkspaceTab("worktrees"); setMobileShowTerminal(false); }}
        >
          <span>Worktrees</span>
        </button>
      </div>
      {workspaceTab === "agents" ? (
    <div className={`split-layout ${mobileInSession ? "mobile-show-terminal" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="split-sidebar">
        <div className="sidebar-header">
          {selectionMode ? (
            <button className="btn btn-sm sidebar-cancel-selection" onClick={handleExitSelectionMode}>Cancel selection</button>
          ) : (
            <>
              <button
                className="btn btn-primary btn-sm sidebar-new-agent-btn"
                onClick={() => openNewAgent()}
                data-tutorial="new-session-btn"
                title={`New agent (${NEW_AGENT_SHORTCUT})`}
              >
                New agent
              </button>
              <div className="sidebar-actions">
                {sessions.length > 1 && (
                  <button className="sidebar-select-link" onClick={() => setSelectionMode(true)}>Select</button>
                )}
                {sessions.length > 0 && (
                  <button className="sidebar-stop-all-link" onClick={handleStopAll}>Stop all</button>
                )}
              </div>
            </>
          )}
          <button
            className="btn btn-sm sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(true)}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            {/* Same doubled chevron as collapse-all, turned to point at the edge it
                folds toward. The guillemet this replaces had font-dependent spacing. */}
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="13 4 9.5 8 13 12" />
              <polyline points="6.5 4 3 8 6.5 12" />
            </svg>
          </button>
        </div>

        {!selectionMode && quickLaunches.length > 0 && (
          <div className="agent-shortcuts-row">
            {quickLaunches.map((ql) => (
              <div key={ql.id} className="agent-quick-launch">
                <button
                  className="agent-shortcut-btn"
                  onClick={() => handleQuickLaunch(ql)}
                  disabled={launchingId === ql.id}
                  title={ql.targets.join(", ")}
                >
                  {launchingId === ql.id ? "..." : ql.label}
                </button>
                <button
                  className="agent-quick-launch-remove"
                  onClick={() => removeQuickLaunch(ql.id)}
                  title="Remove quick launch"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="session-toolbar-row">
        {sessions.length > 0 && (
          <div className="session-search-wrap">
            <input
              ref={sessionSearchRef}
              type="text"
              className="session-search"
              placeholder="Search agents... (⌘K)"
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
            <option value="__repo__">Project</option>
            {metaPresets.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
          {groupBy && groupedSessions && (
            <button
              className={`session-group-collapse-all ${collapsedGroups.size > 0 ? "" : "is-up"}`}
              onClick={() => {
                const allKeys = [...Object.keys(groupedSessions.groups)];
                if (groupedSessions.ungrouped.length > 0) allKeys.push("__ungrouped__");
                const allCollapsed = allKeys.every(k => collapsedGroups.has(k));
                const next = allCollapsed ? new Set<string>() : new Set(allKeys);
                setCollapsedGroups(next);
                updatePreferences({ collapsedGroups: [...next] });
              }}
              title={collapsedGroups.size > 0 ? "Expand all" : "Collapse all"}
              aria-label={collapsedGroups.size > 0 ? "Expand all groups" : "Collapse all groups"}
            >
              {/* Doubled chevron: same family as the per-group \u25B8/\u25BE, with the second
                  stroke reading as "all of them". Points down to expand, up to
                  collapse. */}
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="4 3 8 6.5 12 3" />
                <polyline points="4 9.5 8 13 12 9.5" />
              </svg>
            </button>
          )}
        </div>
        </div>
        {missingTools.length > 0 && !missingToolsDismissed && (
          <div className="missing-tools-banner">
            <span className="missing-tools-icon">⚠</span>
            <span className="missing-tools-text">
              Required tool{missingTools.length > 1 ? "s" : ""} not installed:{" "}
              <strong>{missingTools.join(", ")}</strong>.
              {" "}Check Settings → Health for install instructions.
            </span>
            <button className="missing-tools-dismiss" onClick={() => setMissingToolsDismissed(true)}>✕</button>
          </div>
        )}
        <div className="session-list" data-tutorial="session-list">
          {loading ? (
            <div className="loading">LOADING...</div>
          ) : sessions.length === 0 ? (
            // Nothing here: the logo is 27 columns of un-wrappable <pre> and just
            // clipped at this width, and the main view alongside already explains
            // the empty state.
            null
          ) : filteredSessions.length === 0 && sessionSearch.trim() ? (
            // Agents exist but the search hides them all — without this the list
            // renders blank, which reads as "they're gone".
            <div className="empty-state">
              <p>no agents match “{sessionSearch.trim()}”</p>
              <button className="btn btn-sm" onClick={() => setSessionSearch("")}>
                Clear search
              </button>
            </div>
          ) : groupBy && groupedSessions ? (
            <>
              {Object.entries(groupedSessions.groups).map(([value, entries]) => (
                <div
                  key={value}
                  className={`session-group ${!isDerivedGroup && dragIdx !== null ? "session-group-drop-target" : ""}`}
                  onDragOver={!isDerivedGroup ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } : undefined}
                  onDrop={!isDerivedGroup ? (e) => {
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
                    <span className={`session-group-label ${groupBy === "__status__" ? `status-${value}` : ""}`}>{groupLabel(value, groupBy)}</span>
                    <span className="session-group-count">{entries.filter(e => !e.isChild).length}</span>
                    {/* Seeds the create form with this meta property. A derived group
                        has no property to seed, so it gets no + button. */}
                    {!isDerivedGroup && (
                      <button
                        className="session-group-add"
                        onClick={(e) => { e.stopPropagation(); openNewAgent({ [groupBy]: value }); }}
                        title={`New agent in ${value}`}
                      >+</button>
                    )}
                  </div>
                  {!collapsedGroups.has(value) && entries.map(({ session, isChild, isLastChild, childrenSummary, childrenExpanded, parentIdx }, index) => (
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
                      onRequestStop={requestStopSession}
                      draggable={!isChild}
                      onDragStart={!isChild ? (e: React.DragEvent) => { e.dataTransfer.setData("text/plain", session.name); setDragIdx(parentIdx); } : undefined}
                      onDragEnd={!isChild ? handleDragEnd : undefined}
                      isDragging={!isChild && dragIdx === parentIdx}
                      onEditProps={metaPresets.length > 0 ? () => setEditingSession(session) : undefined}
                      onSaveQuickLaunch={() => handleSaveQuickLaunch(session)}
                      onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                      onForkSession={session.status !== "stopped" ? () => handleForkSession(session) : undefined}
                      dataTutorial={getDemoTutorialAttr(session)}
                      ordinal={index + 1}
                      selectionMode={selectionMode}
                      selected={selectedSessions.has(session.name)}
                      onToggleSelect={session.external ? undefined : () => setSelectedSessions(prev => { const next = new Set(prev); next.has(session.name) ? next.delete(session.name) : next.add(session.name); return next; })}
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
                  {!collapsedGroups.has("__ungrouped__") && groupedSessions.ungrouped.map(({ session, isChild, isLastChild, childrenSummary, childrenExpanded, parentIdx }, index) => (
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
                      onRequestStop={requestStopSession}
                      draggable={!isChild}
                      onDragStart={!isChild ? (e: React.DragEvent) => { e.dataTransfer.setData("text/plain", session.name); setDragIdx(parentIdx); } : undefined}
                      onDragEnd={!isChild ? handleDragEnd : undefined}
                      isDragging={!isChild && dragIdx === parentIdx}
                      onEditProps={metaPresets.length > 0 ? () => setEditingSession(session) : undefined}
                      onSaveQuickLaunch={() => handleSaveQuickLaunch(session)}
                      onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                      onForkSession={session.status !== "stopped" ? () => handleForkSession(session) : undefined}
                      dataTutorial={getDemoTutorialAttr(session)}
                      ordinal={index + 1}
                      selectionMode={selectionMode}
                      selected={selectedSessions.has(session.name)}
                      onToggleSelect={session.external ? undefined : () => setSelectedSessions(prev => { const next = new Set(prev); next.has(session.name) ? next.delete(session.name) : next.add(session.name); return next; })}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            filteredSessions.map(({ session, isChild, isLastChild, childrenSummary, childrenExpanded, parentIdx }, index) => (
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
                onRequestStop={requestStopSession}
                draggable={!isChild}
                onDragStart={!isChild ? handleDragStart(parentIdx) : undefined}
                onDragOver={!isChild ? handleDragOver(parentIdx) : undefined}
                onDragEnd={!isChild ? handleDragEnd : undefined}
                onDrop={!isChild ? handleDrop(parentIdx) : undefined}
                isDragging={!isChild && dragIdx === parentIdx}
                isDragOver={!isChild && dragOverIdx === parentIdx && dragIdx !== parentIdx}
                onEditProps={metaPresets.length > 0 ? () => setEditingSession(session) : undefined}
                onSaveQuickLaunch={() => handleSaveQuickLaunch(session)}
                onRestore={session.status === "stopped" ? () => handleRestoreSession(session.name) : undefined}
                onForkSession={session.status !== "stopped" ? () => handleForkSession(session) : undefined}
                dataTutorial={getDemoTutorialAttr(session)}
                ordinal={index + 1}
                selectionMode={selectionMode}
                selected={selectedSessions.has(session.name)}
                onToggleSelect={session.external ? undefined : () => setSelectedSessions(prev => { const next = new Set(prev); next.has(session.name) ? next.delete(session.name) : next.add(session.name); return next; })}
              />
            ))
          )}
        </div>
        {selectionMode && (
          <div className="selection-action-bar">
            <button className="selection-select-all" onClick={handleToggleSelectAll}>
              {selectedSessions.size === selectableSessions.length ? "None" : "All"}
            </button>
            <span className="selection-count">
              {selectedSessions.size > 0 ? `${selectedSessions.size} selected` : "Tap to select"}
            </span>
            <button
              className="btn btn-stop btn-sm"
              onClick={handleKillSelected}
              disabled={selectedSessions.size === 0}
            >
              {selectedSessions.size > 0 ? `Stop ${selectedSessions.size}` : "Stop"}
            </button>
          </div>
        )}
      </div>

      {/* Lives between the panes rather than inside the tab bar, so it survives both
          cases the old placement missed: no agent selected (tab bar absent) and
          mobile (tab bar hidden). Takes layout space, so it never covers content. */}
      {sidebarCollapsed && (
        <button
          className="sidebar-expand-rail"
          onClick={() => setSidebarCollapsed(false)}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="3 4 6.5 8 3 12" />
            <polyline points="9.5 4 13 8 9.5 12" />
          </svg>
        </button>
      )}

      <div className="split-main">
        {activeSession ? (
          <>
            <div className="main-tabs">
              <button
                className="main-tab mobile-back-btn"
                onClick={() => setMobileShowTerminal(false)}
              >
                &lt; agents
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
            <div className={`main-content main-content-split${splitFullscreen ? " main-content-fullscreen" : ""}`} ref={splitContainerRef}>
              <div className="split-terminal-pane" data-tutorial="terminal-pane" style={bottomTab ? { height: bottomMaximized ? "0%" : `${splitRatio * 100}%` } : undefined}>
                {activeSessionInfo?.status === "stopped" ? (
                  <div className="stopped-session-placeholder" role="status" aria-live="polite">
                    <div className="stopped-session-icon" aria-hidden="true">⏹</div>
                    <div className="stopped-session-copy">
                      <div className="stopped-session-kicker">Agent stopped</div>
                      <div className="stopped-session-title">{activeSessionInfo.displayName}</div>
                      <div className="stopped-session-desc">Restore this agent to continue with its saved conversation history.</div>
                    </div>
                    <button
                      className="btn btn-primary stopped-session-restore-btn"
                      onClick={() => handleRestoreSession(activeSession)}
                    >
                      ↺ Restore agent
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
                    fullscreenTargetRef={splitContainerRef}
                    onFullscreenChange={setSplitFullscreen}
                    onFullscreenPanelShortcut={handleFullscreenPanelShortcut}
                    onSwipeBack={() => setMobileShowTerminal(false)}
                    onKeyboardVisibilityChange={setKbOpen}
                    isActive={!bottomTab}
                    readOnly={sessions.find((s) => s.name === activeSession)?.external}
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
                    review
                  </button>
                  <button
                    className={`main-tab ${bottomTab === "git-log" ? "main-tab-active" : ""}`}
                    onClick={() => setBottomTab(bottomTab === "git-log" ? null : "git-log")}
                  >
                    git log
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
                    title="Browse repository files"
                    aria-label="Browse repository files"
                  >
                    explorer
                  </button>
                  <button
                    className={`main-tab ${bottomTab === "shell" ? "main-tab-active" : ""}`}
                    onClick={() => setBottomTab(bottomTab === "shell" ? null : "shell")}
                    title="Open a shell in this agent's worktree"
                    aria-label="Open a shell in this agent's worktree"
                  >
                    shell
                  </button>
                  {bottomTab && (
                    <button
                      className="main-tab split-maximize-btn"
                      onClick={() => setBottomMaximized(!bottomMaximized)}
                      title={bottomMaximized ? "Restore split view" : "Expand panel"}
                      aria-label={bottomMaximized ? "Restore split view" : "Expand panel"}
                      aria-pressed={bottomMaximized}
                    >
                      <span className="split-maximize-icon" aria-hidden="true">{bottomMaximized ? "▭" : "⛶"}</span>
                      <span className="split-maximize-label">{bottomMaximized ? "split" : "expand"}</span>
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
                  ) : bottomTab === "git-log" ? (
                    <GitLogView
                      key={activeSession}
                      sessionPaths={activeSessionPaths}
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
                      ref={fileExplorerRef}
                      roots={activeSessionPaths}
                      onClose={() => {
                        setBottomTab(null);
                        setTimeout(() => window.dispatchEvent(new Event("agentdock-focus-terminal")), 50);
                      }}
                    />
                  ) : bottomTab === "shell" ? (
                    <ShellView
                      key={activeSession}
                      sessionName={activeSession}
                      worktrees={activeSessionInfo?.worktrees ?? []}
                      onClose={() => setBottomTab(null)}
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
            {/* "Select an agent" only makes sense when there is something to select. */}
            {sessions.length === 0 ? (
              <>
                <pre className="split-empty-logo" aria-hidden="true">{ASCII_LOGO}</pre>
                <button className="btn btn-primary" onClick={() => openNewAgent()}>
                  New agent
                </button>
              </>
            ) : (
              <span className="split-empty-text">Select an agent</span>
            )}
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
                      <button className="btn" onClick={() => setSetupStep("password")}>
                        Skip
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="setup-description">
                      Optionally set a password to protect the dashboard when accessed over the network.
                      <span
                        className="setup-help-icon"
                        style={{ marginLeft: 6 }}
                        data-tooltip={"Recommended if you access agentdock from your phone or other devices on your network.\nLeave blank if you only use it locally on this machine."}
                      >i</span>
                    </p>
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
      {confirmAction && (
        <ConfirmActionModal
          action={confirmAction}
          onClose={() => setConfirmAction(null)}
        />
      )}
      {newAgentModal && (
        <CreateSessionModal
          initialMetaValues={newAgentModal.initialMetaValues}
          initialTargetMode={newAgentModal.initialTargetMode}
          initialSessionName={newAgentModal.initialSessionName}
          initialTargets={newAgentModal.initialTargets}
          initialAgentType={newAgentModal.initialAgentType}
          onClose={closeNewAgent}
          onCreated={handleNewAgentCreated}
        />
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
      ) : (
        <WorktreesView onAgentCreated={handleNewAgentCreated} />
      )}
    </div>

    {/* FAB: new agent, only on the agents list */}
    {!mobileInSession && workspaceTab === "agents" && (
      <button className="session-fab" onClick={() => openNewAgent()} aria-label="New agent" title={`New agent (${NEW_AGENT_SHORTCUT})`}>
        +
      </button>
    )}

    {/* Bottom navigation bar */}
    {workspaceTab === "agents" && (
    <nav className="mobile-bottom-nav">
      <button
        className={`mobile-nav-item ${!mobileInSession ? "mobile-nav-item-active" : ""}`}
        onClick={() => setMobileShowTerminal(false)}
      >
        <span className="mobile-nav-icon">⊟</span>
        <span className="mobile-nav-label">Agents</span>
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
            <span className="mobile-nav-label">Review</span>
          </button>
          <button
            className={`mobile-nav-item ${bottomTab === "git-log" ? "mobile-nav-item-active" : ""}`}
            onClick={() => { setBottomTab("git-log"); setBottomMaximized(true); }}
          >
            <span className="mobile-nav-icon">≣</span>
            <span className="mobile-nav-label">Log</span>
          </button>
          <button
            className={`mobile-nav-item ${bottomTab === "files" ? "mobile-nav-item-active" : ""}`}
            onClick={() => { setBottomTab("files"); setBottomMaximized(true); }}
            title="Browse repository files"
            aria-label="Browse repository files"
          >
            <span className="mobile-nav-icon">⊞</span>
            <span className="mobile-nav-label">Explorer</span>
          </button>
        </>
      )}
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
                <span className={`mru-switcher-status mru-status-${sess ? getDisplayStatus(sess) : "unknown"}`} />
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
