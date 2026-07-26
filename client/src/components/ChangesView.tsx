import { useState, useEffect, useCallback, useMemo, useRef, useId, type CSSProperties } from "react";
import { fetchGitChanges, fetchPRDiff, pushChanges, sendSessionInput } from "../api";
import { isDemo } from "../demo";

interface Props {
  sessionPaths: string[];
  sessionName?: string;
  onCommentsSent?: () => void;
}

interface DiffFile {
  path: string;
  hunks: string;
  additions: number;
  deletions: number;
}

interface PendingComment {
  id: string;
  filePath: string;
  selectedCode: string;
  comment: string;
}

function parseDiff(raw: string): DiffFile[] {
  if (!raw.trim()) return [];
  const files: DiffFile[] = [];
  const parts = raw.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const headerMatch = part.match(/^diff --git a\/(.+?) b\/(.+)/m);
    if (!headerMatch) continue;
    const path = headerMatch[2];
    let additions = 0;
    let deletions = 0;
    for (const line of part.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    files.push({ path, hunks: part, additions, deletions });
  }
  return files;
}

interface StatusEntry {
  code: string;
  path: string;
}

type ChangeKind = "conflict" | "modified" | "added" | "new" | "renamed" | "copied" | "deleted" | "typechange" | "other";

interface StatusMeta {
  text: string;
  className: string;
  kind: ChangeKind;
  scope: string;
}

interface ChangeOverviewEntry extends StatusEntry {
  meta: StatusMeta;
  treePath: string;
  treeName: string;
  diff?: DiffFile;
  anchorId?: string;
}

interface ChangeTreeStats {
  files: number;
  additions: number;
  deletions: number;
}

interface ChangeTreeFolder {
  name: string;
  path: string;
  depth: number;
  folders: ChangeTreeFolder[];
  files: ChangeOverviewEntry[];
  stats: ChangeTreeStats;
}

const CHANGE_GROUP_ORDER: ChangeKind[] = ["conflict", "modified", "added", "new", "renamed", "copied", "deleted", "typechange", "other"];

const CHANGE_GROUP_TITLES: Record<ChangeKind, string> = {
  conflict: "Needs attention",
  modified: "Modified",
  added: "Added",
  new: "New files",
  renamed: "Renamed",
  copied: "Copied",
  deleted: "Deleted",
  typechange: "Type changed",
  other: "Other changes",
};

function normalizeStatusCode(code: string): string {
  return (code + "  ").slice(0, 2);
}

function parseStatus(raw: string): StatusEntry[] {
  if (!raw.trim()) return [];
  return raw.split("\n").filter((line) => line.trim().length > 0).map((line) => ({
    code: normalizeStatusCode(line.slice(0, 2)),
    path: line.length > 3 ? line.slice(3) : line.slice(2).trim(),
  }));
}

function statusScope(code: string): string {
  const normalized = normalizeStatusCode(code);
  const x = normalized[0];
  const y = normalized[1];
  if (x === "?" && y === "?") return "untracked";
  const staged = x !== " " && x !== "?";
  const unstaged = y !== " " && y !== "?";
  if (staged && unstaged) return "staged + unstaged";
  if (staged) return "staged";
  if (unstaged) return "unstaged";
  return "changed";
}

function statusLabel(code: string): StatusMeta {
  const normalized = normalizeStatusCode(code);
  const x = normalized[0];
  const y = normalized[1];
  const pair = `${x}${y}`;
  const scope = statusScope(normalized);

  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(pair) || x === "U" || y === "U") {
    return { text: "conflict", className: "status-conflict", kind: "conflict", scope };
  }
  if (x === "?" && y === "?") return { text: "new", className: "status-new", kind: "new", scope };
  if (x === "R" || y === "R") return { text: "renamed", className: "status-renamed", kind: "renamed", scope };
  if (x === "C" || y === "C") return { text: "copied", className: "status-copied", kind: "copied", scope };
  if (x === "A" || y === "A") return { text: "added", className: "status-added", kind: "added", scope };
  if (x === "D" || y === "D") return { text: "deleted", className: "status-deleted", kind: "deleted", scope };
  if (x === "T" || y === "T") return { text: "type", className: "status-type", kind: "typechange", scope };
  if (x === "M" || y === "M") return { text: "modified", className: "status-modified", kind: "modified", scope };
  return { text: normalized.trim() || "changed", className: "status-other", kind: "other", scope };
}

function diffLookupPath(path: string): string {
  if (!path.includes(" -> ")) return path;
  return path.split(" -> ").pop()?.trim() || path;
}

function splitFilePath(path: string): { directory: string; name: string } {
  if (path.includes(" -> ")) return { directory: "", name: path };
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { directory: "", name: path };
  return { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

function emptyTreeStats(): ChangeTreeStats {
  return { files: 0, additions: 0, deletions: 0 };
}

function addEntryStats(stats: ChangeTreeStats, entry: ChangeOverviewEntry): void {
  stats.files += 1;
  stats.additions += entry.diff?.additions || 0;
  stats.deletions += entry.diff?.deletions || 0;
}

function createTreeFolder(name: string, path: string, depth: number): ChangeTreeFolder {
  return { name, path, depth, folders: [], files: [], stats: emptyTreeStats() };
}

function sortChangeTree(folder: ChangeTreeFolder): ChangeTreeFolder {
  folder.folders.sort((a, b) => a.name.localeCompare(b.name));
  folder.files.sort((a, b) => a.treeName.localeCompare(b.treeName));
  folder.folders.forEach(sortChangeTree);
  return folder;
}

function buildChangeTree(entries: ChangeOverviewEntry[]): ChangeTreeFolder {
  const root = createTreeFolder("", "", -1);

  for (const entry of entries) {
    const segments = entry.treePath.split("/").filter(Boolean);
    const folders = segments.slice(0, -1);
    const ancestors = [root];
    let current = root;

    for (const folderName of folders) {
      const folderPath = current.path ? `${current.path}/${folderName}` : folderName;
      let next = current.folders.find((folder) => folder.name === folderName);
      if (!next) {
        next = createTreeFolder(folderName, folderPath, current.depth + 1);
        current.folders.push(next);
      }
      current = next;
      ancestors.push(current);
    }

    current.files.push(entry);
    ancestors.forEach((folder) => addEntryStats(folder.stats, entry));
  }

  return sortChangeTree(root);
}

function treeDepthStyle(depth: number): CSSProperties {
  return { "--tree-indent": `${Math.max(0, depth) * 18}px` } as CSSProperties;
}

function ChangeTreeStatsView({ stats }: { stats: ChangeTreeStats }) {
  return (
    <span className="changes-tree-stats">
      <span>{stats.files} file{stats.files === 1 ? "" : "s"}</span>
      {stats.additions > 0 && <span className="diff-stat-add">+{stats.additions}</span>}
      {stats.deletions > 0 && <span className="diff-stat-del">-{stats.deletions}</span>}
    </span>
  );
}

function ChangeFileTreeRow({ entry, depth, onSelect }: {
  entry: ChangeOverviewEntry;
  depth: number;
  onSelect: (anchorId?: string) => void;
}) {
  const clickable = Boolean(entry.anchorId);

  return (
    <button
      className={`changes-file-row${clickable ? " changes-file-row-clickable" : ""}`}
      type="button"
      style={treeDepthStyle(depth)}
      title={entry.path}
      onClick={() => onSelect(entry.anchorId)}
      aria-disabled={!clickable}
      aria-label={clickable ? `Show diff for ${entry.path}` : entry.path}
      tabIndex={clickable ? 0 : -1}
    >
      <span className={`changes-file-marker ${entry.meta.className}`} aria-hidden="true" />
      <span className="changes-file-main">
        <span className="changes-file-name">{entry.treeName}</span>
      </span>
      <span className="changes-file-meta">
        <span className={`changes-file-badge ${entry.meta.className}`}>{entry.meta.text}</span>
        <span className="changes-file-scope">{entry.meta.scope}</span>
        {entry.diff && (entry.diff.additions > 0 || entry.diff.deletions > 0) && (
          <span className="changes-file-stats">
            {entry.diff.additions > 0 && <span className="diff-stat-add">+{entry.diff.additions}</span>}
            {entry.diff.deletions > 0 && <span className="diff-stat-del">-{entry.diff.deletions}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

function ChangeTreeFolderRow({ folder, onSelect }: {
  folder: ChangeTreeFolder;
  onSelect: (anchorId?: string) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="changes-tree-folder">
      <button
        className="changes-tree-folder-row"
        type="button"
        style={treeDepthStyle(folder.depth)}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className="changes-tree-toggle" aria-hidden="true">{open ? "\u25BE" : "\u25B8"}</span>
        <span className="changes-tree-folder-name">{folder.name}</span>
        <ChangeTreeStatsView stats={folder.stats} />
      </button>
      {open && (
        <div className="changes-tree-children">
          {folder.folders.map((child) => (
            <ChangeTreeFolderRow
              key={child.path}
              folder={child}
              onSelect={onSelect}
            />
          ))}
          {folder.files.map((entry) => (
            <ChangeFileTreeRow
              key={`${entry.code}-${entry.path}`}
              entry={entry}
              depth={folder.depth + 1}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChangeFileOverview({ statusEntries, diffFiles, diffAnchorPrefix, onSelectDiff }: {
  statusEntries: StatusEntry[];
  diffFiles: DiffFile[];
  diffAnchorPrefix: string;
  onSelectDiff: (anchorId?: string) => void;
}) {
  const diffByPath = useMemo(() => {
    const map = new Map<string, { file: DiffFile; index: number }>();
    diffFiles.forEach((file, index) => map.set(file.path, { file, index }));
    return map;
  }, [diffFiles]);

  const entries = useMemo<ChangeOverviewEntry[]>(() => statusEntries.map((entry) => {
    const meta = statusLabel(entry.code);
    const treePath = diffLookupPath(entry.path);
    const diffMatch = diffByPath.get(treePath);
    const treeName = splitFilePath(treePath).name || entry.path;
    return {
      ...entry,
      meta,
      treePath,
      treeName: entry.path.includes(" -> ") ? entry.path : treeName,
      diff: diffMatch?.file,
      anchorId: diffMatch ? `${diffAnchorPrefix}-${diffMatch.index}` : undefined,
    };
  }), [statusEntries, diffByPath, diffAnchorPrefix]);

  const summaryGroups = CHANGE_GROUP_ORDER.map((kind) => ({
    kind,
    title: CHANGE_GROUP_TITLES[kind],
    items: entries.filter((entry) => entry.meta.kind === kind),
  })).filter((group) => group.items.length > 0);

  const tree = useMemo(() => buildChangeTree(entries), [entries]);
  if (entries.length === 0) return null;

  return (
    <section className="changes-overview" aria-label="Changed files">
      <div className="changes-overview-header">
        <span className="changes-overview-title">Changed files</span>
        <span className="changes-overview-count">{entries.length} total</span>
      </div>
      {summaryGroups.length > 0 && (
        <div className="changes-kind-summary">
          {summaryGroups.map((group) => (
            <span key={group.kind} className={`changes-kind-chip ${group.items[0].meta.className}`}>
              <span>{group.title}</span>
              <span className="changes-kind-count">{group.items.length}</span>
            </span>
          ))}
        </div>
      )}
      <div className="changes-file-tree">
        {tree.folders.map((folder) => (
          <ChangeTreeFolderRow
            key={folder.path}
            folder={folder}
            onSelect={onSelectDiff}
          />
        ))}
        {tree.files.map((entry) => (
          <ChangeFileTreeRow
            key={`${entry.code}-${entry.path}`}
            entry={entry}
            depth={0}
            onSelect={onSelectDiff}
          />
        ))}
      </div>
    </section>
  );
}

interface Selection {
  fileIdx: number;
  startLine: number;
  endLine: number;
}

function DiffBlock({
  file,
  fileIdx,
  defaultOpen,
  selection,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onTouchStart,
  isDragging,
  onLineClick,
  onAddComment,
  sessionName,
  tutorialTarget,
  anchorId,
  openRequest,
}: {
  file: DiffFile;
  fileIdx: number;
  defaultOpen: boolean;
  selection: Selection | null;
  onMouseDown: (fileIdx: number, lineIdx: number) => void;
  onMouseMove: (fileIdx: number, lineIdx: number) => void;
  onMouseUp: () => void;
  onTouchStart: (fileIdx: number, lineIdx: number, clientX: number, clientY: number) => void;
  isDragging: React.MutableRefObject<boolean>;
  onLineClick: (fileIdx: number, lineIdx: number, shiftKey: boolean) => void;
  onAddComment: (filePath: string, selectedCode: string, comment: string) => void;
  sessionName?: string;
  tutorialTarget?: string;
  anchorId?: string;
  openRequest?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (!openRequest) return;
    setOpen(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (anchorId) document.getElementById(anchorId)?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    });
  }, [anchorId, openRequest]);
  const [comment, setComment] = useState("");
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const lines = useMemo(() => file.hunks.split("\n"), [file.hunks]);

  const isSelected = selection && selection.fileIdx === fileIdx;
  const selStart = isSelected ? Math.min(selection!.startLine, selection!.endLine) : -1;
  const selEnd = isSelected ? Math.max(selection!.startLine, selection!.endLine) : -1;

  useEffect(() => {
    if (isSelected && commentRef.current) {
      commentRef.current.focus();
    }
  }, [isSelected, selEnd]);

  // Native touchmove listener with { passive: false } to prevent scroll during drag
  useEffect(() => {
    const pre = preRef.current;
    if (!pre) return;

    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
      if (!el) return;
      const lineEl = el.closest("[data-line-idx]") as HTMLElement | null;
      if (!lineEl) return;
      const fIdx = parseInt(lineEl.dataset.fileIdx || "-1", 10);
      const lIdx = parseInt(lineEl.dataset.lineIdx || "-1", 10);
      if (fIdx >= 0 && lIdx >= 0) {
        onMouseMove(fIdx, lIdx);
      }
    };

    pre.addEventListener("touchmove", handleTouchMove, { passive: false });
    return () => pre.removeEventListener("touchmove", handleTouchMove);
  }, [isDragging, onMouseMove]);

  const handleAddComment = () => {
    if (!comment.trim()) return;
    const selectedLines = lines.slice(selStart, selEnd + 1)
      .filter((l) => l.trim())
      .join("\n");
    onAddComment(file.path, selectedLines, comment.trim());
    setComment("");
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
    if (e.key === "Escape") {
      setComment("");
      onLineClick(-1, -1, false);
    }
  };

  const renderedLines = useMemo(() => {
    if (!open) return null;
    const result: React.ReactNode[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let cls = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) cls += " diff-add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls += " diff-del";
      else if (line.startsWith("@@")) cls += " diff-hunk";
      else if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) cls += " diff-meta";

      const inSelection = isSelected && i >= selStart && i <= selEnd;
      if (inSelection) cls += " diff-selected";

      result.push(
        <div
          key={i}
          className={cls}
          data-file-idx={fileIdx}
          data-line-idx={i}
          onMouseMove={() => onMouseMove(fileIdx, i)}
          onMouseUp={() => onMouseUp()}
        >
          <div className="diff-gutter">
            <button
              className="diff-gutter-btn"
              tabIndex={-1}
              aria-label="Add comment to this line"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) return; // let onClick handle shift-extend
                onMouseDown(fileIdx, i);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey) {
                  onLineClick(fileIdx, i, true);
                } else if (!isDragging.current) {
                  // Pure click (no drag): select just this line
                  onLineClick(fileIdx, i, false);
                }
              }}
              onTouchStart={(e) => {
                e.stopPropagation();
                // Immediately select on touch (no long-press delay needed for gutter)
                onMouseDown(fileIdx, i);
              }}
            >
              +
            </button>
          </div>
          <div className="diff-line-code">{line || " "}</div>
        </div>,
      );

      if (isSelected && i === selEnd && sessionName) {
        result.push(
          <div key={`comment-${i}`} className="diff-comment-box">
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
              <button
                className="btn btn-primary btn-sm"
                onClick={handleAddComment}
                disabled={!comment.trim()}
              >
                add comment
              </button>
              <button
                className="btn btn-sm"
                onClick={() => { setComment(""); onLineClick(-1, -1, false); }}
              >
                cancel
              </button>
            </div>
          </div>,
        );
      }
    }
    return result;
  }, [lines, open, isSelected, selStart, selEnd, comment, sessionName, fileIdx, onMouseDown, onMouseMove, onMouseUp, onTouchStart, onLineClick]);

  return (
    <div className="diff-file" id={anchorId}>
      <button className="diff-file-header" onClick={() => setOpen(!open)}>
        <span className="diff-file-toggle">{open ? "\u25BE" : "\u25B8"}</span>
        <span className="diff-file-path">{file.path}</span>
        <span className="diff-file-stats">
          {file.additions > 0 && <span className="diff-stat-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="diff-stat-del">-{file.deletions}</span>}
        </span>
      </button>
      {open && (
        <pre ref={preRef} className="diff-file-content" data-tutorial={tutorialTarget}>{renderedLines}</pre>
      )}
    </div>
  );
}

function CommentBatchBar({
  comments,
  sending,
  onRemove,
  onClear,
  onSendAll,
}: {
  comments: PendingComment[];
  sending: boolean;
  onRemove: (id: string) => void;
  onClear: () => void;
  onSendAll: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (comments.length === 0) return null;

  return (
    <div className="comment-batch-bar" data-tutorial="comment-batch-bar">
      <div className="comment-batch-summary" onClick={() => setExpanded(!expanded)}>
        <span className="comment-batch-count">
          {comments.length} comment{comments.length !== 1 ? "s" : ""}
        </span>
        <div className="comment-batch-actions">
          <span className="comment-batch-expand">{expanded ? "\u25BE" : "\u25B8"}</span>
          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onClear(); }}>
            clear
          </button>
          <button
            className="btn btn-primary btn-sm"
            data-tutorial="send-to-claude-btn"
            onClick={(e) => { e.stopPropagation(); onSendAll(); }}
            disabled={sending}
          >
            {sending ? "sending..." : "send all to claude"}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="comment-batch-list">
          {comments.map((c) => (
            <div key={c.id} className="comment-batch-item">
              <div className="comment-batch-item-header">
                <span className="comment-batch-item-file">{c.filePath}</span>
                <button
                  className="comment-batch-item-remove"
                  onClick={() => onRemove(c.id)}
                >
                  &times;
                </button>
              </div>
              <pre className="comment-batch-item-code">{c.selectedCode}</pre>
              <div className="comment-batch-item-text">{c.comment}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shows changes for a single repo path */
function RepoChanges({ sessionPath, sessionName, showRepoLabel, onCommentsSent }: {
  sessionPath: string;
  sessionName?: string;
  showRepoLabel: boolean;
  onCommentsSent?: () => void;
}) {
  const [status, setStatus] = useState("");
  const [diff, setDiff] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(true);
  const [existingPrUrl, setExistingPrUrl] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState("");
  const [pushSuccess, setPushSuccess] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [viewMode, setViewMode] = useState<"local" | "pr">("local");
  const [prDiff, setPrDiff] = useState("");
  const [prDiffLoading, setPrDiffLoading] = useState(false);
  const [prDiffError, setPrDiffError] = useState("");
  const diffAnchorPrefix = useId().replace(/:/g, "");
  const [openDiffRequests, setOpenDiffRequests] = useState<Record<string, number>>({});

  // Batch comment state — pre-seed one comment in demo mode so the batch bar is visible
  const [pendingComments, setPendingComments] = useState<PendingComment[]>(() =>
    isDemo() ? [{
      id: "demo-comment-1",
      filePath: "auth/token_manager.go",
      selectedCode: "+\tresult, err, _ := tm.sfGroup.Do(\"refresh\", func() (interface{}, error) {",
      comment: "add a timeout context here so a slow identity provider can't stall all requests",
    }] : []
  );
  const [batchSending, setBatchSending] = useState(false);

  // Drag state (refs to avoid re-renders)
  const isDraggingRef = useRef(false);
  const dragFileIdxRef = useRef(-1);
  const lastDragLineRef = useRef(-1);

  // Long-press touch state
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPosRef = useRef({ x: 0, y: 0 });
  const LONG_PRESS_DELAY = 400;
  const MOVE_CANCEL_THRESHOLD = 8;

  const load = useCallback(() => {
    fetchGitChanges(sessionPath).then((data) => {
      setStatus(data.status);
      setDiff(data.diff);
      setBranch(data.branch);
      setExistingPrUrl(data.prUrl);
      setLoading(false);
    });
  }, [sessionPath]);

  useEffect(() => {
    setLoading(true);
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (viewMode !== "pr" || !existingPrUrl) return;
    setPrDiffLoading(true);
    setPrDiffError("");
    fetchPRDiff(sessionPath)
      .then((data) => setPrDiff(data.diff))
      .catch((err) => setPrDiffError(err.message))
      .finally(() => setPrDiffLoading(false));
  }, [viewMode, existingPrUrl, sessionPath]);

  // Global mouseup/touchend to end drag even if released outside diff area
  useEffect(() => {
    const onMouseUp = () => { isDraggingRef.current = false; };
    const onTouchEnd = () => {
      isDraggingRef.current = false;
      if (touchTimerRef.current !== null) {
        clearTimeout(touchTimerRef.current);
        touchTimerRef.current = null;
      }
    };
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  // Drag event handlers
  const handleMouseDown = useCallback((fileIdx: number, lineIdx: number) => {
    isDraggingRef.current = true;
    dragFileIdxRef.current = fileIdx;
    lastDragLineRef.current = lineIdx;
    setSelection({ fileIdx, startLine: lineIdx, endLine: lineIdx });
  }, []);

  const handleMouseMove = useCallback((fileIdx: number, lineIdx: number) => {
    if (!isDraggingRef.current) return;
    if (fileIdx !== dragFileIdxRef.current) return;
    if (lineIdx === lastDragLineRef.current) return;
    lastDragLineRef.current = lineIdx;
    setSelection(prev => prev ? { ...prev, endLine: lineIdx } : null);
  }, []);

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const handleTouchStart = useCallback((fileIdx: number, lineIdx: number, clientX: number, clientY: number) => {
    touchStartPosRef.current = { x: clientX, y: clientY };
    if (touchTimerRef.current !== null) clearTimeout(touchTimerRef.current);
    touchTimerRef.current = setTimeout(() => {
      touchTimerRef.current = null;
      isDraggingRef.current = true;
      dragFileIdxRef.current = fileIdx;
      lastDragLineRef.current = lineIdx;
      setSelection({ fileIdx, startLine: lineIdx, endLine: lineIdx });
    }, LONG_PRESS_DELAY);
  }, []);

  const handleLineClick = useCallback((fileIdx: number, lineIdx: number, shiftKey: boolean) => {
    if (fileIdx === -1) {
      setSelection(null);
      return;
    }
    if (shiftKey) {
      setSelection(prev => {
        if (prev && prev.fileIdx === fileIdx) {
          return { ...prev, endLine: lineIdx };
        }
        return { fileIdx, startLine: lineIdx, endLine: lineIdx };
      });
    } else {
      // Plain click on "+" — single-line selection
      setSelection({ fileIdx, startLine: lineIdx, endLine: lineIdx });
    }
  }, []);

  // Batch comment handlers
  const handleAddComment = useCallback((filePath: string, selectedCode: string, comment: string) => {
    setPendingComments(prev => [...prev, {
      id: crypto.randomUUID(),
      filePath,
      selectedCode,
      comment,
    }]);
    setSelection(null);
  }, []);

  const handleRemoveComment = useCallback((id: string) => {
    setPendingComments(prev => prev.filter(c => c.id !== id));
  }, []);

  const handleSendAll = async () => {
    if (!sessionName || pendingComments.length === 0) return;
    setBatchSending(true);
    try {
      const message = pendingComments.map(c =>
        `In file ${c.filePath}:\n\`\`\`\n${c.selectedCode}\n\`\`\`\n${c.comment}`
      ).join("\n\n---\n\n");
      await sendSessionInput(sessionName, message);
      setPendingComments([]);
      onCommentsSent?.();
    } catch (err) {
      console.error("Failed to send comments:", err);
    } finally {
      setBatchSending(false);
    }
  };

  const handleClearAll = useCallback(() => {
    setPendingComments([]);
  }, []);

  const handleSelectDiffFromTree = useCallback((anchorId?: string) => {
    if (!anchorId) return;
    setOpenDiffRequests((prev) => ({ ...prev, [anchorId]: (prev[anchorId] || 0) + 1 }));
  }, []);

  const handlePush = async () => {
    setPushing(true);
    setPushError("");
    setPushSuccess(false);
    try {
      await pushChanges(sessionPath);
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
    } catch (err: any) {
      setPushError(err.message);
    } finally {
      setPushing(false);
    }
  };

  // Cancel long-press if finger moves (i.e. user is scrolling)
  const diffContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = diffContainerRef.current;
    if (!el) return;
    const handleTouchMove = (e: TouchEvent) => {
      if (touchTimerRef.current === null) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartPosRef.current.x;
      const dy = touch.clientY - touchStartPosRef.current.y;
      if (Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL_THRESHOLD) {
        clearTimeout(touchTimerRef.current);
        touchTimerRef.current = null;
      }
    };
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    return () => el.removeEventListener("touchmove", handleTouchMove);
  }, []);

  const diffFiles = useMemo(() => parseDiff(diff), [diff]);
  const prDiffFiles = useMemo(() => parseDiff(prDiff), [prDiff]);
  const statusEntries = useMemo(() => parseStatus(status), [status]);
  const activeDiffFiles = viewMode === "pr" ? prDiffFiles : diffFiles;
  const totalAdd = activeDiffFiles.reduce((s, f) => s + f.additions, 0);
  const totalDel = activeDiffFiles.reduce((s, f) => s + f.deletions, 0);

  // Extract short repo name from path (last directory component)
  const repoLabel = sessionPath.split("/").filter(Boolean).pop() || sessionPath;

  if (loading) {
    return (
      <div className="repo-changes">
        {showRepoLabel && <div className="repo-changes-label">{repoLabel}</div>}
        <div className="plan-loading">loading changes...</div>
      </div>
    );
  }

  const hasChanges = status.trim().length > 0;

  const diffBlockProps = {
    selection,
    onMouseDown: handleMouseDown,
    onMouseMove: handleMouseMove,
    onMouseUp: handleMouseUp,
    onTouchStart: handleTouchStart,
    isDragging: isDraggingRef,
    onLineClick: handleLineClick,
    onAddComment: handleAddComment,
    sessionName,
  };

  return (
    <div className="repo-changes" ref={diffContainerRef}>
      <div className="changes-header">
        <div className="changes-header-row">
          <div className="changes-header-left">
            {showRepoLabel && <span className="repo-changes-name">{repoLabel}</span>}
            {(hasChanges || viewMode === "pr") && activeDiffFiles.length > 0 && (
              <span className="changes-summary">
                {activeDiffFiles.length} file{activeDiffFiles.length !== 1 ? "s" : ""}
                {totalAdd > 0 && <span className="diff-stat-add"> +{totalAdd}</span>}
                {totalDel > 0 && <span className="diff-stat-del"> -{totalDel}</span>}
              </span>
            )}
          </div>
          <div className="changes-header-actions">
            <button className="btn btn-sm changes-refresh-btn" onClick={load} title="Refresh">↻</button>
            {hasChanges && existingPrUrl && (
              <button className="btn btn-primary btn-sm" onClick={handlePush} disabled={pushing}>
                {pushing ? "..." : "push"}
              </button>
            )}
          </div>
        </div>
        <span className={`branch-label changes-branch${branch ? "" : " branch-label-muted"}`}>{branch || "unknown"}</span>
        {existingPrUrl && (
          <div className="changes-view-switcher">
            <button
              className={`changes-switcher-btn${viewMode === "local" ? " changes-switcher-active" : ""}`}
              onClick={() => setViewMode("local")}
            >
              local
            </button>
            <button
              className={`changes-switcher-btn${viewMode === "pr" ? " changes-switcher-active" : ""}`}
              onClick={() => setViewMode("pr")}
            >
              pr diff
            </button>
          </div>
        )}
      </div>

      {existingPrUrl && (
        <a className="changes-pr-chip" href={existingPrUrl} target="_blank" rel="noopener noreferrer">
          <span className="changes-pr-chip-text">{existingPrUrl.replace("https://github.com/", "")}</span>
          <span className="changes-pr-chip-icon">↗</span>
        </a>
      )}

      {pushSuccess && <div className="changes-pr-success">pushed successfully</div>}
      {pushError && <div className="form-error">{pushError}</div>}


      {viewMode === "pr" ? (
        prDiffLoading ? (
          <div className="plan-loading">loading pr diff...</div>
        ) : prDiffError ? (
          <div className="form-error">
            {prDiffError}
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => {
              setPrDiffLoading(true);
              setPrDiffError("");
              fetchPRDiff(sessionPath)
                .then((data) => setPrDiff(data.diff))
                .catch((err: any) => setPrDiffError(err.message))
                .finally(() => setPrDiffLoading(false));
            }}>retry</button>
          </div>
        ) : prDiffFiles.length === 0 ? (
          <div className="plan-empty">no pr diff available</div>
        ) : (
          <div className="diff-files">
            {prDiffFiles.map((file, i) => (
              <DiffBlock
                key={file.path}
                file={file}
                fileIdx={i}
                defaultOpen={prDiffFiles.length <= 3}
                {...diffBlockProps}
              />
            ))}
          </div>
        )
      ) : !hasChanges ? (
        <div className="plan-empty">no changes — working tree clean</div>
      ) : (
        <>
          <ChangeFileOverview
            statusEntries={statusEntries}
            diffFiles={diffFiles}
            diffAnchorPrefix={diffAnchorPrefix}
            onSelectDiff={handleSelectDiffFromTree}
          />

          {diffFiles.length > 0 && (
            <div className="diff-files">
              {diffFiles.map((file, i) => (
                <DiffBlock
                  key={file.path}
                  file={file}
                  fileIdx={i}
                  defaultOpen={diffFiles.length <= 3}
                  tutorialTarget={i === 0 ? "diff-file-content" : undefined}
                  anchorId={`${diffAnchorPrefix}-${i}`}
                  openRequest={openDiffRequests[`${diffAnchorPrefix}-${i}`] || 0}
                  {...diffBlockProps}
                />
              ))}
            </div>
          )}
        </>
      )}

      <CommentBatchBar
        comments={pendingComments}
        sending={batchSending}
        onRemove={handleRemoveComment}
        onClear={handleClearAll}
        onSendAll={handleSendAll}
      />
    </div>
  );
}

export function ChangesView({ sessionPaths, sessionName, onCommentsSent }: Props) {
  if (sessionPaths.length === 0) {
    return (
      <div className="changes-view">
        <div className="plan-empty">no repo path available</div>
      </div>
    );
  }

  const limitedPaths = sessionPaths.slice(0, 4);
  const multiRepo = limitedPaths.length > 1;

  return (
    <div className="changes-view">
      {limitedPaths.map((p) => (
        <RepoChanges
          key={p}
          sessionPath={p}
          sessionName={sessionName}
          showRepoLabel={multiRepo}
          onCommentsSent={onCommentsSent}
        />
      ))}
    </div>
  );
}
