import { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef, useMemo } from "react";
import { fetchFsDir, fetchFsFile } from "../api";
import type { FsEntry, GrepResult } from "../api";
import { Icon } from "./Icon";
import { FileSearch, type FileSearchHandle } from "./FileSearch";
import "../styles/files.css";
import "highlight.js/styles/atom-one-dark.css";
import hljs from "highlight.js/lib/core";
// Register only the languages we actually need — keeps bundle lean
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml"; // html
import sql from "highlight.js/lib/languages/sql";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("plaintext", plaintext);

function highlight(content: string, language: string): string {
  try {
    const lang = hljs.getLanguage(language) ? language : "plaintext";
    return hljs.highlight(content, { language: lang }).value;
  } catch {
    return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

interface Props {
  roots: string[]; // absolute paths to repo root(s)
  onClose?: () => void;
}

export interface FileExplorerHandle {
  focusSearch: () => void;
}

interface OpenFile {
  path: string;
  content: string;
  language: string;
  size: number;
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

/** Scroll the pre container so the mark is vertically centered in the viewport. */
function scrollMarkIntoView(pre: HTMLElement, mark: HTMLElement | undefined): void {
  if (!mark) return;
  const preRect = pre.getBoundingClientRect();
  const markRect = mark.getBoundingClientRect();
  // markRect is relative to viewport; convert to position within the pre's scroll content
  const markTopInPre = markRect.top - preRect.top + pre.scrollTop;
  pre.scrollTop = markTopInPre - pre.clientHeight / 3;
}

type PerRootsState = {
  openFile: OpenFile | null;
  expandedDirs: Set<string>;
  dirContents: DirContents;
};

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({ roots, onClose }, ref) {
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
  const [fileSearchMatchCount, setFileSearchMatchCount] = useState(0);
  const [fileSearchIdx, setFileSearchIdx] = useState(0);
  const fileContentRef = useRef<HTMLPreElement>(null);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);

  // Filename search state
  const fileSearchRef = useRef<FileSearchHandle>(null);

  // When opening a grep result, remember target line to scroll to after render
  const targetLineRef = useRef<number | null>(null);

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

  // Apply/clear in-file search marks in DOM
  useEffect(() => {
    const pre = fileContentRef.current;
    if (!pre) return;

    // Clear existing marks — extract children back into parent, then remove the mark
    // NOTE: do NOT call parent.normalize() here — it merges adjacent text nodes and
    // destroys any active browser text selection.
    pre.querySelectorAll("mark.fe-match").forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
    });

    if (!fileSearchQuery.trim() || !fileSearchActive) {
      setFileSearchMatchCount(0);
      return;
    }

    const query = fileSearchQuery.toLowerCase();
    const marks: HTMLElement[] = [];
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      textNodes.push(node);
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent || "";
      const lower = text.toLowerCase();
      let start = 0;
      let idx: number;
      const parts: (string | HTMLElement)[] = [];
      while ((idx = lower.indexOf(query, start)) !== -1) {
        if (idx > start) parts.push(text.slice(start, idx));
        const mark = document.createElement("mark");
        mark.className = "fe-match";
        mark.textContent = text.slice(idx, idx + query.length);
        parts.push(mark);
        marks.push(mark);
        start = idx + query.length;
      }
      if (parts.length > 0) {
        if (start < text.length) parts.push(text.slice(start));
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          frag.appendChild(typeof p === "string" ? document.createTextNode(p) : p);
        }
        textNode.parentNode?.replaceChild(frag, textNode);
      }
    }

    setFileSearchMatchCount(marks.length);
    const clampedIdx = Math.min(fileSearchIdx, Math.max(marks.length - 1, 0));
    setFileSearchIdx(clampedIdx);
    marks.forEach((m, i) => m.classList.toggle("fe-match-active", i === clampedIdx));
    scrollMarkIntoView(pre, marks[clampedIdx]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile, fileSearchQuery, fileSearchActive]);

  // Sync active mark when index changes
  useEffect(() => {
    const pre = fileContentRef.current;
    if (!pre) return;
    const marks = Array.from(pre.querySelectorAll<HTMLElement>("mark.fe-match"));
    marks.forEach((m, i) => m.classList.toggle("fe-match-active", i === fileSearchIdx));
    scrollMarkIntoView(pre, marks[fileSearchIdx]);
  }, [fileSearchIdx]);

  const closeFileSearch = useCallback(() => {
    setFileSearchActive(false);
    setFileSearchQuery("");
  }, []);

  // After a grep result opens a file, scroll to the target line
  useEffect(() => {
    const line = targetLineRef.current;
    if (!line || !fileContentRef.current) return;
    targetLineRef.current = null;
    const pre = fileContentRef.current;
    // Approximate: measure line height from computed style
    const style = window.getComputedStyle(pre);
    const lineHeight = parseFloat(style.lineHeight) || 18;
    // Add padding offset
    const paddingTop = parseFloat(style.paddingTop) || 12;
    pre.scrollTop = paddingTop + (line - 1) * lineHeight - pre.clientHeight / 3;
  }, [openFile]);

  const handleOpenGrepResult = useCallback(async (result: GrepResult) => {
    targetLineRef.current = result.lineNumber;
    if (openFile?.path !== result.path) {
      setLoadingPath(result.path);
      setError(null);
      try {
        const data = await fetchFsFile(result.path, roots);
        setOpenFile({ path: result.path, ...data });
      } catch (err: any) {
        setError(err.message || "Failed to read file");
        targetLineRef.current = null;
      } finally {
        setLoadingPath(null);
      }
    } else {
      // File already open — scroll immediately
      const pre = fileContentRef.current;
      if (pre) {
        const style = window.getComputedStyle(pre);
        const lineHeight = parseFloat(style.lineHeight) || 18;
        const paddingTop = parseFloat(style.paddingTop) || 12;
        pre.scrollTop = paddingTop + (result.lineNumber - 1) * lineHeight - pre.clientHeight / 3;
      }
      targetLineRef.current = null;
    }
  }, [openFile, roots]);

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

  // Memoize highlighted HTML — prevents React from needlessly resetting the code element's
  // innerHTML on unrelated state changes (e.g. fileSearchIdx), which would destroy marks
  // and any in-progress text selection.
  const highlightedHtml = useMemo(
    () => openFile ? highlight(openFile.content, openFile.language) : "",
    [openFile],
  );

  // Relative path from root for breadcrumb
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
          onOpenFile={(path, line) => {
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
            <pre ref={fileContentRef} className="fe-file-content"><code
              className={`hljs language-${openFile.language}`}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            /></pre>
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
