import { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef, useMemo } from "react";
import { fetchFsDir, fetchFsFile, writeFsFile, sendSessionInput } from "../api";
import type { FsEntry, GrepResult } from "../api";
import { Icon } from "./Icon";
import { FileSearch, type FileSearchHandle } from "./FileSearch";
import { CodeViewLazy, type CodeViewHandle } from "./CodeViewLazy";
import "../styles/code-nav.css";
import { findDefinition, fetchDocSymbols, type Candidate, type DocSymbol } from "../code-api";
import { buildNoteMessage } from "../note-message";
import "../styles/files.css";
interface Props {
  roots: string[]; // absolute paths to repo root(s)
  onClose?: () => void;
  /** The session a note goes to. Without one the note UI stays out of the way. */
  sessionName?: string;
}

export interface FileExplorerHandle {
  focusSearch: () => void;
}

interface OpenFile {
  path: string;
  content: string;
  language: string;
  size: number;
  version: string;
}


// Map of dirPath → entries (only what's been expanded)
type DirContents = Map<string, FsEntry[]>;

function getBasename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

interface ChangeCount {
  added: number;
  removed: number;
}

interface TreeChanges {
  /** absolute file path → counts */
  files: Map<string, ChangeCount>;
  /** absolute paths of directories with a changed descendant */
  dirs: Set<string>;
  /** absolute paths of wholly untracked directories, which porcelain collapses */
  newDirs: string[];
  /** repo root → sum across that root */
  totals: Map<string, ChangeCount>;
}

const NO_CHANGES: TreeChanges = { files: new Map(), dirs: new Set(), newDirs: [], totals: new Map() };

const GIT_ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 };
const pathEncoder = new TextEncoder();
const pathDecoder = new TextDecoder();

/** Reverse git's C-style quoting, which it applies to any path with an unusual byte. */
function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const src = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "\\") {
      for (const b of pathEncoder.encode(src[i])) bytes.push(b);
      continue;
    }
    const esc = src[++i];
    if (esc >= "0" && esc <= "7") {
      bytes.push(parseInt(src.slice(i, i + 3), 8));
      i += 2;
      continue;
    }
    bytes.push(GIT_ESCAPES[esc] ?? esc.charCodeAt(0));
  }
  return pathDecoder.decode(new Uint8Array(bytes));
}

function parseHeaderPath(raw: string): string | null {
  let path: string;
  if (raw.startsWith('"')) {
    let i = 1;
    while (i < raw.length && raw[i] !== '"') i += raw[i] === "\\" ? 2 : 1;
    path = unquoteGitPath(raw.slice(0, i + 1));
  } else {
    // git appends a tab-delimited marker to header paths containing spaces
    const tab = raw.indexOf("\t");
    path = tab === -1 ? raw : raw.slice(0, tab);
  }
  if (path === "/dev/null") return null;
  return /^[abciwo]\/./.test(path) ? path.slice(2) : path;
}

/** Repo-relative path → added/removed line counts, from unified diff text. */
function parseDiffCounts(diff: string): Map<string, ChangeCount> {
  const counts = new Map<string, ChangeCount>();
  let current: ChangeCount | null = null;
  let oldPath: string | null = null;
  // Content lines can themselves start with --- or +++, so only read headers outside a hunk
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (!inHunk) {
      if (line.startsWith("--- ")) {
        oldPath = parseHeaderPath(line.slice(4));
      } else if (line.startsWith("+++ ")) {
        const path = parseHeaderPath(line.slice(4)) ?? oldPath;
        if (path) {
          current = counts.get(path) ?? { added: 0, removed: 0 };
          counts.set(path, current);
        }
      }
    } else if (current) {
      if (line.startsWith("+")) current.added++;
      else if (line.startsWith("-")) current.removed++;
    }
  }
  return counts;
}

function parseStatusPaths(status: string): { path: string; isDir: boolean }[] {
  const out: { path: string; isDir: boolean }[] = [];
  for (const raw of status.split("\n")) {
    if (raw.length < 4) continue;
    let rest = raw.slice(3);
    const arrow = rest.lastIndexOf(" -> ");
    if (arrow !== -1) rest = rest.slice(arrow + 4);
    const path = unquoteGitPath(rest.trim());
    if (!path) continue;
    out.push({ path: path.replace(/\/$/, ""), isDir: path.endsWith("/") });
  }
  return out;
}

function markAncestors(dirs: Set<string>, root: string, absPath: string): void {
  let dir = absPath.slice(0, absPath.lastIndexOf("/"));
  while (dir.length > root.length && dir.startsWith(root)) {
    dirs.add(dir);
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
}

interface RootChanges {
  root: string;
  status: string;
  diff: string;
}

function buildTreeChanges(fetched: RootChanges[]): TreeChanges {
  const files = new Map<string, ChangeCount>();
  const dirs = new Set<string>();
  const newDirs: string[] = [];
  const totals = new Map<string, ChangeCount>();

  for (const { root, status, diff } of fetched) {
    const diffCounts = parseDiffCounts(diff);
    const total = { added: 0, removed: 0 };
    const fromStatus = new Set<string>();

    const addFile = (rel: string, count: ChangeCount) => {
      const abs = `${root}/${rel}`;
      files.set(abs, count);
      total.added += count.added;
      total.removed += count.removed;
      markAncestors(dirs, root, abs);
    };

    for (const entry of parseStatusPaths(status)) {
      if (entry.isDir) {
        const abs = `${root}/${entry.path}`;
        newDirs.push(abs);
        dirs.add(abs);
        markAncestors(dirs, root, abs);
        continue;
      }
      fromStatus.add(entry.path);
      addFile(entry.path, diffCounts.get(entry.path) ?? { added: 0, removed: 0 });
    }
    for (const [rel, count] of diffCounts) {
      if (!fromStatus.has(rel)) addFile(rel, count);
    }
    totals.set(root, total);
  }

  return { files, dirs, newDirs, totals };
}

function dirHasChanges(changes: TreeChanges, path: string): boolean {
  if (changes.dirs.has(path)) return true;
  return changes.newDirs.some((d) => path === d || path.startsWith(`${d}/`));
}

async function fetchRootChanges(root: string): Promise<RootChanges | null> {
  try {
    const res = await fetch(`/api/git/changes?path=${encodeURIComponent(root)}`);
    if (!res.ok) return null;
    const data = await res.json() as { status?: string; diff?: string };
    return { root, status: data.status || "", diff: data.diff || "" };
  } catch {
    return null;
  }
}

function ChangeCounts({ count }: { count?: ChangeCount }) {
  if (!count || (count.added === 0 && count.removed === 0)) return null;
  return (
    <span className="fe-change-counts">
      {count.added > 0 && <span className="fe-change-add">+{count.added}</span>}
      {count.removed > 0 && <span className="fe-change-del">−{count.removed}</span>}
    </span>
  );
}

type RowKeyHandler = (e: React.KeyboardEvent<HTMLDivElement>, path: string, type: "file" | "dir") => void;

interface TreeNodeProps {
  path: string;
  name: string;
  type: "file" | "dir";
  ext?: string;
  dirContents: DirContents;
  expandedDirs: Set<string>;
  loadingPath: string | null;
  openFilePath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRowKeyDown: RowKeyHandler;
  changes: TreeChanges;
  depth: number;
}

function TreeNode({
  path, name, type,
  dirContents, expandedDirs, loadingPath, openFilePath,
  onToggleDir, onOpenFile, onRowKeyDown, changes, depth,
}: TreeNodeProps) {
  const isExpanded = expandedDirs.has(path);
  const isLoading = loadingPath === path;
  const isActive = openFilePath === path;
  const children = dirContents.get(path);

  return (
    <div className="fe-tree-node">
      <div
        className={`fe-tree-item${isActive ? " fe-tree-item-active" : ""}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => type === "dir" ? onToggleDir(path) : onOpenFile(path)}
        onKeyDown={(e) => onRowKeyDown(e, path, type)}
        data-fe-row=""
        tabIndex={-1}
        role="treeitem"
        aria-expanded={type === "dir" ? isExpanded : undefined}
      >
        {type === "dir" ? (
          <span className={`fe-dir-arrow${isExpanded ? " fe-dir-arrow-open" : ""}`}>
            <Icon name="chevr" size={12} />
          </span>
        ) : (
          <span className="fe-icon fe-icon-file"><Icon name="file" size={13} /></span>
        )}
        <span className="fe-tree-name">{name}</span>
        {isLoading && <span className="fe-spinner"><Icon name="refresh" size={12} className="fe-spin" /></span>}
        {type === "dir"
          ? dirHasChanges(changes, path) && <Icon name="dot" size={8} className="fe-change-dot" title="contains changes" />
          : <ChangeCounts count={changes.files.get(path)} />}
      </div>
      {isExpanded && children && (
        <div className="fe-tree-children">
          {children.map((entry) => (
            <TreeNode
              key={entry.name}
              path={`${path}/${entry.name}`}
              name={entry.name}
              type={entry.type}
              ext={entry.ext}
              dirContents={dirContents}
              expandedDirs={expandedDirs}
              loadingPath={loadingPath}
              openFilePath={openFilePath}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onRowKeyDown={onRowKeyDown}
              changes={changes}
              depth={depth + 1}
            />
          ))}
          {children.length === 0 && (
            <div className="fe-tree-empty" style={{ paddingLeft: `${8 + (depth + 1) * 16}px` }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type PerRootsState = {
  openFile: OpenFile | null;
  expandedDirs: Set<string>;
  dirContents: DirContents;
};

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({ roots, onClose, sessionName }, ref) {
  const [dirContents, setDirContents] = useState<DirContents>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Per-roots state cache — preserves open file + tree when switching sessions
  const stateCache = useRef<Map<string, PerRootsState>>(new Map());
  const prevRootsKey = useRef<string>("");
  // Always-current snapshot of state for saving (avoids stale closure)
  const liveState = useRef<PerRootsState>({ openFile: null, expandedDirs: new Set(), dirContents: new Map() });
  liveState.current = { openFile, expandedDirs, dirContents };

  // When roots change (session switch): save current state, restore saved state for new roots
  useEffect(() => {
    const rootsKey = roots.join(",");
    if (rootsKey === prevRootsKey.current) return;
    // Save state for outgoing roots
    if (prevRootsKey.current) {
      stateCache.current.set(prevRootsKey.current, {
        openFile: liveState.current.openFile,
        expandedDirs: new Set(liveState.current.expandedDirs),
        dirContents: new Map(liveState.current.dirContents),
      });
    }
    // Restore state for incoming roots
    const saved = stateCache.current.get(rootsKey);
    if (saved) {
      setOpenFile(saved.openFile);
      setExpandedDirs(saved.expandedDirs);
      setDirContents(saved.dirContents);
    } else {
      setOpenFile(null);
      // Auto-expand all roots so the tree is usable immediately
      setExpandedDirs(new Set(roots));
      setDirContents(new Map());
      // Fetch root directory contents in background
      roots.forEach(async (root) => {
        try {
          const entries = await fetchFsDir(root, roots);
          setDirContents((prev) => new Map(prev).set(root, entries));
        } catch {}
      });
    }
    setError(null);
    prevRootsKey.current = rootsKey;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots.join(",")]);

  // Changed-line counts per root — one fetch + parse per roots change, never per render
  const [changes, setChanges] = useState<TreeChanges>(NO_CHANGES);

  useEffect(() => {
    let cancelled = false;
    setChanges(NO_CHANGES);
    if (roots.length === 0) return;
    (async () => {
      const fetched = await Promise.all(roots.map(fetchRootChanges));
      if (cancelled) return;
      setChanges(buildTreeChanges(fetched.filter((r): r is RootChanges => r !== null)));
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots.join(",")]);

  // File search (Cmd+F)
  const [fileSearchActive, setFileSearchActive] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [fileSearchIdx, setFileSearchIdx] = useState(0);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);

  // Filename search state
  const fileSearchRef = useRef<FileSearchHandle>(null);
  const pendingMarkRef = useRef<{ path: string; line: number | null } | null>(null);
  // Editing. `draft` is null while the file is being viewed rather than edited.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ theirs: string; version: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Code navigation
  const [navBusy, setNavBusy] = useState(false);
  const [picker, setPicker] = useState<{ name: string; candidates: Candidate[] } | null>(null);
  const [outline, setOutline] = useState<DocSymbol[] | null>(null);
  const [showOutline, setShowOutline] = useState(false);

  /* ─── Note on a selection ───────────────────────────────────────────────
     Point at code and say something about it, without retyping the path and
     the line numbers into the terminal. One note at a time: it is sent as soon
     as you press send, so there is nothing to collect. */
  const [selection, setSelection] = useState<{ text: string; startLine: number; endLine: number } | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteSent, setNoteSent] = useState(false);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const [modDown, setModDown] = useState(false);
  const [usagesFor, setUsagesFor] = useState<string | null>(null);
  const backStack = useRef<{ path: string; line: number }[]>([]);
  // Bumped on every open-from-search, so clicking a second match in the file
  // already on screen still moves the active highlight.
  const [markNonce, setMarkNonce] = useState(0);


  useImperativeHandle(ref, () => ({
    focusSearch: () => fileSearchRef.current?.focus(),
  }));

  // Cmd+Shift+F — switch to content search mode
  // Cmd+F — in-file search (only when file is open)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "F" && e.shiftKey) {
        e.preventDefault();
        fileSearchRef.current?.focus();
      } else if (e.key === "f" && !e.shiftKey && openFile) {
        e.preventDefault();
        setFileSearchActive(true);
        setTimeout(() => {
          fileSearchInputRef.current?.focus();
          fileSearchInputRef.current?.select();
        }, 30);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openFile]);

  const closeFileSearch = useCallback(() => {
    setFileSearchActive(false);
    setFileSearchQuery("");
  }, []);

  const handleOpenGrepResult = useCallback(async (result: GrepResult) => {
    if (openFile?.path === result.path) {
      // Already open: CodeMirror knows where line N is; no line-height maths.
      setActiveMatchLine(result.lineNumber);
      codeRef.current?.goToLine(result.lineNumber);
      return;
    }
    pendingMarkRef.current = { path: result.path, line: result.lineNumber };
    setLoadingPath(result.path);
    setError(null);
    try {
      const data = await fetchFsFile(result.path, roots);
      setOpenFile({ path: result.path, ...data });
    } catch (err: any) {
      setError(err.message || "Failed to read file");
      pendingMarkRef.current = null;
    } finally {
      setLoadingPath(null);
    }
  }, [openFile, roots]);

  const handleToggleDir = useCallback(async (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        return next;
      }
      next.add(path);
      return next;
    });

    // Only fetch if we haven't loaded this dir yet
    if (!dirContents.has(path)) {
      setLoadingPath(path);
      setError(null);
      try {
        const entries = await fetchFsDir(path, roots);
        setDirContents((prev) => new Map(prev).set(path, entries));
      } catch (err: any) {
        setError(err.message || "Failed to list directory");
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      } finally {
        setLoadingPath(null);
      }
    }
  }, [dirContents, roots]);

  const handleOpenFile = useCallback(async (path: string) => {
    if (openFile?.path === path) return;
    setLoadingPath(path);
    setError(null);
    try {
      const data = await fetchFsFile(path, roots);
      setOpenFile({ path, ...data });
    } catch (err: any) {
      setError(err.message || "Failed to read file");
    } finally {
      setLoadingPath(null);
    }
  }, [openFile, roots]);

  const rowContainerRef = useRef<HTMLDivElement>(null);

  const handleRowKeyDown = useCallback<RowKeyHandler>((e, path, type) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (type === "dir") handleToggleDir(path);
      else handleOpenFile(path);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = Array.from(rowContainerRef.current?.querySelectorAll<HTMLElement>("[data-fe-row]") ?? []);
      rows[rows.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (type === "dir" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const shouldExpand = e.key === "ArrowRight";
      if (shouldExpand !== expandedDirs.has(path)) {
        e.preventDefault();
        handleToggleDir(path);
      }
    }
  }, [handleToggleDir, handleOpenFile, expandedDirs]);

  const openFilePath = openFile?.path ?? null;

  // Resizable tree panel
  const [treePanelWidth, setTreePanelWidth] = useState(240);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = treePanelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = ev.clientX - dragStartX.current;
      const newWidth = Math.max(140, Math.min(480, dragStartWidth.current + delta));
      setTreePanelWidth(newWidth);
    };
    const onMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [treePanelWidth]);

  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    setTreePanelWidth((w) => Math.max(140, Math.min(480, w + step)));
  }, []);

  const shownContent = draft ?? openFile?.content ?? "";

  // CodeMirror owns rendering: highlighting, caret, selection and search marks
  // all come from it. The hand-rolled stack it replaces was highlight.js into
  // dangerouslySetInnerHTML, marks spliced into that html, and a transparent
  // textarea laid on top.
  const [fileSearchMatchCount, setFileSearchMatchCount] = useState(0);
  const [activeMatchLine, setActiveMatchLine] = useState<number | null>(null);
  const codeRef = useRef<CodeViewHandle>(null);

  const dirty = draft !== null && openFile !== null && draft !== openFile.content;
  const editing = draft !== null;

  const startEditing = useCallback(() => {
    if (!openFile) return;
    setDraft(openFile.content);
    setSaveError(null);
  }, [openFile]);

  const stopEditing = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setDraft(null);
    setConflict(null);
    setSaveError(null);
  }, [dirty]);

  const goTo = useCallback(
    async (path: string, line: number, pushHistory = true) => {
      if (pushHistory && openFile) {
        backStack.current.push({ path: openFile.path, line: 1 });
        if (backStack.current.length > 50) backStack.current.shift();
      }
      setPicker(null);
      setUsagesFor(null);
      await handleOpenGrepResult({ path, name: path.split("/").pop() || path, lineNumber: line, line: "" });
    },
    [openFile],
  );

  const goBack = useCallback(() => {
    const prev = backStack.current.pop();
    if (prev) goTo(prev.path, prev.line, false);
  }, [goTo]);

  /**
   * Clicking a name jumps to where it is declared. Clicking the declaration
   * itself is a different question — you already know where it is — so that
   * shows where it is used instead.
   */
  const navigateToSymbol = useCallback(
    async (name: string, atLine?: number) => {
      if (!openFile) return;
      setNavBusy(true);
      try {
        const res = await findDefinition(name, roots, openFile.path);
        // Judged by the line that was clicked. Using the scroll position for
        // this made the answer depend on where the file happened to be
        // scrolled, which is why repeat clicks behaved differently each time.
        const here = res.candidates.filter((c) => c.path === openFile.path);
        const atDefinition = atLine !== undefined && here.some((c) => Math.abs(c.line - atLine) <= 1);

        if (res.candidates.length === 0 || atDefinition) {
          // Textual usages, not semantic references — the index knows
          // declarations, not call sites. Whole-word so `Load` does not drag in
          // `Loader` and `Preload`.
          fileSearchRef.current?.search(name, { wholeWord: true });
          setFileSearchQuery(name);
          setFileSearchActive(true);
          setUsagesFor(name);
          return;
        }
        if (res.candidates.length === 1) {
          await goTo(res.candidates[0].path, res.candidates[0].line);
          return;
        }
        setPicker({ name, candidates: res.candidates });
      } finally {
        setNavBusy(false);
      }
    },
    [openFile, roots, goTo],
  );

  // Cmd/Ctrl underlines identifiers so it is obvious what is clickable.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.metaKey || e.ctrlKey) setModDown(true); };
    const up = (e: KeyboardEvent) => { if (!e.metaKey && !e.ctrlKey) setModDown(false); };
    const blur = () => setModDown(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    if (!openFile) { setOutline(null); return; }
    let alive = true;
    fetchDocSymbols(openFile.path, roots)
      .then((s) => { if (alive) setOutline(s); })
      .catch(() => { if (alive) setOutline([]); });
    return () => { alive = false; };
  }, [openFile?.path, roots.join(",")]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
      if (e.key === "F12" && !typing && openFile) {
        e.preventDefault();
        const sel = window.getSelection()?.toString().trim();
        if (sel && /^[A-Za-z_$][\w$]*$/.test(sel)) navigateToSymbol(sel);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "[") { e.preventDefault(); goBack(); return; }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "o" || e.key === "O")) {
        if (!openFile) return;
        e.preventDefault();
        setShowOutline((v) => !v);
        return;
      }
      if (e.key === "Escape" && picker) { e.preventDefault(); setPicker(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile, navigateToSymbol, goBack, picker]);

  const discardEdits = useCallback(() => {
    setDraft(null);
    setConflict(null);
    setSaveError(null);
  }, []);

  const save = useCallback(async (force = false) => {
    if (!openFile || draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await writeFsFile(openFile.path, roots, draft, openFile.version, force);
      if ("conflict" in res) {
        setConflict({ theirs: res.currentContent, version: res.currentVersion });
        return;
      }
      setOpenFile({ ...openFile, content: draft, version: res.version, size: res.size });
      setDraft(null);
      setConflict(null);
    } catch (err: any) {
      setSaveError(err?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [openFile, draft, roots]);

  const takeTheirs = useCallback(() => {
    if (!openFile || !conflict) return;
    setOpenFile({ ...openFile, content: conflict.theirs, version: conflict.version });
    setDraft(null);
    setConflict(null);
  }, [openFile, conflict]);

  // Cmd+S saves. Without this the browser offers to save the page instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        if (!openFile) return;
        e.preventDefault();
        if (dirty) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save, openFile]);

  // Leaving a file with unsaved edits would lose them silently.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const handleFileSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeFileSearch();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (fileSearchMatchCount === 0) return;
      const delta = e.shiftKey ? -1 : 1;
      setFileSearchIdx((i) => (i + delta + fileSearchMatchCount) % fileSearchMatchCount);
    }
  }, [fileSearchMatchCount, closeFileSearch]);

  // Jump to the match the search result pointed at, once its file is open.
  useEffect(() => {
    const pending = pendingMarkRef.current;
    if (!pending || openFile?.path !== pending.path) return;
    pendingMarkRef.current = null;
    if (pending.line === null) return;
    setActiveMatchLine(pending.line);
    codeRef.current?.goToLine(pending.line);
  }, [openFile]);

  // Relative path from root for breadcrumb
  /* A selection is per-file: keeping one across a navigation would attach a
     note to lines the reader is no longer looking at. */
  useEffect(() => {
    setSelection(null);
    setNoteOpen(false);
    setNoteText("");
    setNoteError(null);
  }, [openFilePath]);

  const openNote = useCallback(() => {
    if (!selection || !sessionName) return;
    setNoteOpen(true);
    setNoteError(null);
    requestAnimationFrame(() => noteInput.current?.focus());
  }, [selection, sessionName]);

  useEffect(() => {
    if (!sessionName) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        if (!selection) return;
        e.preventDefault();
        openNote();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, sessionName, openNote]);

  const sendNote = async () => {
    if (!selection || !sessionName || !openFile) return;
    const note = noteText.trim();
    if (!note) return;
    setNoteBusy(true);
    setNoteError(null);
    try {
      const message = buildNoteMessage({
        path: getBreadcrumb(openFile.path),
        startLine: selection.startLine,
        endLine: selection.endLine,
        code: selection.text,
        note,
        language: openFile.language,
      });
      await sendSessionInput(sessionName, message);
      setNoteOpen(false);
      setNoteText("");
      setNoteSent(true);
      setTimeout(() => setNoteSent(false), 2200);
    } catch (err: any) {
      setNoteError(err?.message || "could not send");
    } finally {
      setNoteBusy(false);
    }
  };

  function getBreadcrumb(filePath: string): string {
    for (const root of roots) {
      if (filePath.startsWith(root + "/")) {
        return filePath.slice(root.length + 1);
      }
    }
    return filePath;
  }

  return (
    <div className="fe-container">
      <div className="fe-tree-panel" style={{ width: treePanelWidth, minWidth: treePanelWidth, maxWidth: treePanelWidth }}>
        <FileSearch
          ref={fileSearchRef}
          roots={roots}
          activePath={openFilePath}
          onOpenFile={(path, line, term) => {
            if (term) {
              // Reuse the in-file search: the term lights up everywhere in the
              // file and the match on the clicked line becomes the active one.
              pendingMarkRef.current = { path, line: line ?? null };
              setFileSearchQuery(term);
              setFileSearchActive(true);
              setMarkNonce((n) => n + 1);
            }
            if (line) handleOpenGrepResult({ path, name: path.split("/").pop() || path, lineNumber: line, line: "" });
            else handleOpenFile(path);
          }}
        >
          <div className="fe-tree-body" ref={rowContainerRef} role="tree">
            {roots.map((root) => (
              <div key={root} className="fe-root-section">
                <div
                  className="fe-root-header"
                  onClick={() => handleToggleDir(root)}
                  onKeyDown={(e) => handleRowKeyDown(e, root, "dir")}
                  data-fe-row=""
                  tabIndex={0}
                  role="treeitem"
                  aria-expanded={expandedDirs.has(root)}
                >
                  <span className={`fe-dir-arrow${expandedDirs.has(root) ? " fe-dir-arrow-open" : ""}`}>
                    <Icon name="chevr" size={12} />
                  </span>
                  <span className="fe-root-name">{getBasename(root)}</span>
                  {loadingPath === root && <span className="fe-spinner"><Icon name="refresh" size={12} className="fe-spin" /></span>}
                  <ChangeCounts count={changes.totals.get(root)} />
                </div>
                {expandedDirs.has(root) && dirContents.has(root) && (
                  <div className="fe-tree-children">
                    {dirContents.get(root)!.map((entry) => (
                      <TreeNode
                        key={entry.name}
                        path={`${root}/${entry.name}`}
                        name={entry.name}
                        type={entry.type}
                        ext={entry.ext}
                        dirContents={dirContents}
                        expandedDirs={expandedDirs}
                        loadingPath={loadingPath}
                        openFilePath={openFilePath}
                        onToggleDir={handleToggleDir}
                        onOpenFile={handleOpenFile}
                        onRowKeyDown={handleRowKeyDown}
                        changes={changes}
                        depth={1}
                      />
                    ))}
                    {dirContents.get(root)!.length === 0 && (
                      <div className="fe-tree-empty" style={{ paddingLeft: "24px" }}>empty</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </FileSearch>
      </div>

      <div
        className="fe-resize-handle"
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
        tabIndex={0}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file tree"
        aria-valuenow={treePanelWidth}
        aria-valuemin={140}
        aria-valuemax={480}
        title="Drag to resize"
      />
      <div className="fe-file-panel">
        {error && (
          <div className="fe-error">{error}</div>
        )}
        {openFile ? (
          <>
            <div className="fe-file-header">
              <span className="fe-file-breadcrumb">{getBreadcrumb(openFile.path)}</span>
              <span className="fe-file-size">{Math.round(openFile.size / 1024 * 10) / 10}KB</span>
              <span className="fe-file-search-hint">⌘F</span>
            </div>
            {fileSearchActive && (
              <div className="fe-file-search-bar">
                <input
                  ref={fileSearchInputRef}
                  className="fe-file-search-input"
                  type="text"
                  placeholder="search in file…"
                  value={fileSearchQuery}
                  onChange={(e) => setFileSearchQuery(e.target.value)}
                  onKeyDown={handleFileSearchKeyDown}
                />
                <span className="fe-file-search-count">
                  {fileSearchMatchCount === 0
                    ? (fileSearchQuery ? "no matches" : "")
                    : `${fileSearchIdx + 1}/${fileSearchMatchCount}`}
                </span>
                <button className="fe-file-search-close" onClick={closeFileSearch} title="Close (Esc)">
                  <Icon name="close" size={12} />
                </button>
              </div>
            )}
            <div className={`fe-code-wrap${editing ? " fe-code-editing" : ""}`}>
              <div className="fe-editbar">
                {editing ? (
                  <>
                    <span className={`fe-editbar-state${dirty ? " fe-editbar-dirty" : ""}`}>
                      {dirty ? "● unsaved" : "no changes"}
                    </span>
                    <button className="fe-editbtn fe-editbtn-primary" onClick={() => save()} disabled={!dirty || saving}>
                      {saving ? "saving…" : "save"}<kbd>⌘S</kbd>
                    </button>
                    <button className="fe-editbtn" onClick={stopEditing}>done</button>
                  </>
                ) : (
                  <button className="fe-editbtn" onClick={startEditing} title="Edit this file">
                    <Icon name="edit" size={12} /> edit
                  </button>
                )}
                <span className="fe-editbar-spacer" />
                {saveError && <span className="fe-editbar-error">{saveError}</span>}
              </div>

              {conflict && (
                <div className="fe-conflict" role="alert">
                  <Icon name="alert" size={13} />
                  <span>Changed on disk since you opened it — the agent probably wrote to it.</span>
                  <span className="fe-conflict-actions">
                    <button onClick={takeTheirs}>reload theirs</button>
                    <button onClick={() => save(true)}>overwrite anyway</button>
                    <button onClick={() => setConflict(null)}>cancel</button>
                  </span>
                </div>
              )}

              <CodeViewLazy
                viewRef={codeRef}
                path={openFile.path}
                content={shownContent}
                editable={editing}
                onChange={setDraft}
                highlightTerm={fileSearchActive ? fileSearchQuery : ""}
                activeLine={activeMatchLine}
                onCmdClick={(word: string, line: number) => navigateToSymbol(word, line)}
                onMatchCount={setFileSearchMatchCount}
                onSelectionChange={sessionName ? setSelection : undefined}
              />

              {sessionName && selection && !noteOpen && (
                <div className="fe-note-bar">
                  <span className="fe-note-range">
                    {selection.startLine === selection.endLine
                      ? `line ${selection.startLine}`
                      : `lines ${selection.startLine}–${selection.endLine}`}
                  </span>
                  <button className="fe-note-btn" onClick={openNote}>
                    <Icon name="send" size={12} /> note to agent<kbd>⌘⇧M</kbd>
                  </button>
                </div>
              )}

              {sessionName && selection && noteOpen && (
                <div className="fe-note" role="dialog" aria-label="Note on the selection">
                  <div className="fe-note-head">
                    <span>
                      {getBreadcrumb(openFile.path)}
                      <span className="fe-note-lines">
                        :{selection.startLine === selection.endLine
                          ? selection.startLine
                          : `${selection.startLine}-${selection.endLine}`}
                      </span>
                    </span>
                    <button onClick={() => { setNoteOpen(false); setNoteError(null); }} aria-label="Close">×</button>
                  </div>
                  <pre className="fe-note-code">{selection.text.split("\n").slice(0, 6).join("\n")}
                    {selection.text.split("\n").length > 6 ? "\n…" : ""}</pre>
                  <textarea
                    ref={noteInput}
                    className="fe-note-input"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.preventDefault(); setNoteOpen(false); }
                      /* Enter alone would be a newline in a note that often wants
                         two sentences; the send key is the one the rest of the
                         app uses to commit a composer. */
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendNote(); }
                    }}
                    placeholder="What should the agent do about this?"
                    rows={3}
                  />
                  <div className="fe-note-foot">
                    {noteError && <span className="fe-note-error">{noteError}</span>}
                    <span className="fe-note-spacer" />
                    <button className="fe-note-btn" onClick={() => setNoteOpen(false)}>cancel</button>
                    <button
                      className="fe-note-btn fe-note-btn-primary"
                      onClick={sendNote}
                      disabled={noteBusy || noteText.trim().length === 0}
                    >
                      {noteBusy ? "sending…" : "send"}<kbd>⌘↵</kbd>
                    </button>
                  </div>
                </div>
              )}

              {noteSent && <div className="fe-note-sent">note sent to {sessionName?.replace(/^claude-/, "")}</div>}

              {navBusy && <div className="fe-nav-busy">looking up…</div>}

              {picker && (
                <div className="fe-picker" role="dialog" aria-label="Choose a definition">
                  <div className="fe-picker-head">
                    <span><code className="fe-picker-name">{picker.name}</code> is declared in {picker.candidates.length} places</span>
                    <button onClick={() => setPicker(null)} aria-label="Close">×</button>
                  </div>
                  <div className="fe-picker-list">
                    {picker.candidates.map((c) => (
                      <button
                        key={`${c.path}:${c.line}`}
                        className="fe-picker-row"
                        onClick={() => goTo(c.path, c.line)}
                      >
                        <span className={`fe-kind fe-kind-${c.kind}`}>{c.kind}</span>
                        <span className="fe-picker-sym">
                          {c.container ? <span className="fe-picker-recv">{c.container}.</span> : null}
                          {c.name}
                        </span>
                        <span className="fe-picker-loc">{c.file}:{c.line}</span>
                      </button>
                    ))}
                  </div>
                  <div className="fe-picker-foot">
                    matched by name — no type information, so pick the one you meant
                  </div>
                </div>
              )}

              {showOutline && outline && outline.length > 0 && (
                <div className="fe-outline" role="navigation" aria-label="Outline">
                  <div className="fe-outline-head">
                    <span>outline<span className="fe-outline-count">{outline.length}</span></span>
                    <button onClick={() => setShowOutline(false)} aria-label="Close">×</button>
                  </div>
                  <div className="fe-outline-list">
                    {outline.map((sym) => (
                      <button
                        key={`${sym.line}:${sym.name}`}
                        className="fe-outline-row"
                        onClick={() => goTo(openFile.path, sym.line, false)}
                      >
                        <span className={`fe-kind fe-kind-${sym.kind}`}>{sym.kind}</span>
                        <span className="fe-outline-name">
                          {sym.container ? <span className="fe-picker-recv">{sym.container}.</span> : null}
                          {sym.name}
                        </span>
                        <span className="fe-outline-line">{sym.line}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="fe-file-empty">
            <span>select a file to view</span>
          </div>
        )}
        {loadingPath && openFilePath !== loadingPath && (
          <div className="fe-file-loading">loading…</div>
        )}
      </div>
    </div>
  );
});
