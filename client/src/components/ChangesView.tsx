import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchGitChanges, fetchPRDiff, createPR, pushChanges, sendSessionInput } from "../api";
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

function parseStatus(raw: string): StatusEntry[] {
  if (!raw.trim()) return [];
  return raw.trim().split("\n").filter(Boolean).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(3),
  }));
}

function statusLabel(code: string): { text: string; className: string } {
  const x = code[0];
  const y = code[1];
  if (x === "?" && y === "?") return { text: "new", className: "status-new" };
  if (x === "A") return { text: "added", className: "status-added" };
  if (x === "D" || y === "D") return { text: "deleted", className: "status-deleted" };
  if (x === "R") return { text: "renamed", className: "status-renamed" };
  if (x === "M" || y === "M") return { text: "modified", className: "status-modified" };
  return { text: code.trim(), className: "status-modified" };
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
}) {
  const [open, setOpen] = useState(defaultOpen);
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
          onMouseDown={(e) => {
            e.preventDefault();
            if (!e.shiftKey) {
              onMouseDown(fileIdx, i);
            }
          }}
          onMouseMove={() => onMouseMove(fileIdx, i)}
          onMouseUp={() => onMouseUp()}
          onTouchStart={(e) => { e.preventDefault(); onTouchStart(fileIdx, i, e.touches[0].clientX, e.touches[0].clientY); }}
          onClick={(e) => {
            if (e.shiftKey) onLineClick(fileIdx, i, true);
          }}
        >
          {line || " "}
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
    <div className="diff-file">
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
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [createdPrUrl, setCreatedPrUrl] = useState("");
  const [prError, setPrError] = useState("");
  const [creatingPr, setCreatingPr] = useState(false);
  const [showPrForm, setShowPrForm] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState("");
  const [pushSuccess, setPushSuccess] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [viewMode, setViewMode] = useState<"local" | "pr">("local");
  const [prDiff, setPrDiff] = useState("");
  const [prDiffLoading, setPrDiffLoading] = useState(false);
  const [prDiffError, setPrDiffError] = useState("");

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

  const handleCreatePR = async () => {
    if (!prTitle.trim()) return;
    setCreatingPr(true);
    setPrError("");
    try {
      const result = await createPR(sessionPath, prTitle, prBody || undefined);
      setCreatedPrUrl(result.url);
      setExistingPrUrl(result.url);
      setShowPrForm(false);
    } catch (err: any) {
      setPrError(err.message);
    } finally {
      setCreatingPr(false);
    }
  };

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
            {hasChanges && existingPrUrl ? (
              <button className="btn btn-primary btn-sm" onClick={handlePush} disabled={pushing}>
                {pushing ? "..." : "push"}
              </button>
            ) : hasChanges && !createdPrUrl ? (
              <button className="btn btn-primary btn-sm" onClick={() => setShowPrForm(!showPrForm)}>
                + pr
              </button>
            ) : null}
          </div>
        </div>
        <span className="changes-branch">{branch || "unknown"}</span>
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

      {createdPrUrl && !existingPrUrl && (
        <div className="changes-pr-success">
          PR created: <a href={createdPrUrl} target="_blank" rel="noopener noreferrer">{createdPrUrl}</a>
        </div>
      )}

      {showPrForm && (
        <div className="changes-pr-form">
          <input
            type="text"
            className="form-input"
            placeholder="PR title"
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
          />
          <textarea
            className="form-textarea"
            placeholder="PR description (optional)"
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            rows={3}
          />
          {prError && <div className="form-error">{prError}</div>}
          <button
            className="btn btn-primary btn-sm"
            onClick={handleCreatePR}
            disabled={creatingPr || !prTitle.trim()}
          >
            {creatingPr ? "creating..." : "submit pr"}
          </button>
        </div>
      )}

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
                defaultOpen={prDiffFiles.length <= 5}
                {...diffBlockProps}
              />
            ))}
          </div>
        )
      ) : !hasChanges ? (
        <div className="plan-empty">no changes — working tree clean</div>
      ) : (
        <>
          <div className="changes-file-list">
            {statusEntries.map((entry, i) => {
              const label = statusLabel(entry.code);
              return (
                <div key={i} className="changes-file-row">
                  <span className={`changes-file-badge ${label.className}`}>{label.text}</span>
                  <span className="changes-file-name">{entry.path}</span>
                </div>
              );
            })}
          </div>

          {diffFiles.length > 0 && (
            <div className="diff-files">
              {diffFiles.map((file, i) => (
                <DiffBlock
                  key={file.path}
                  file={file}
                  fileIdx={i}
                  defaultOpen={diffFiles.length <= 5}
                  tutorialTarget={i === 0 ? "diff-file-content" : undefined}
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
