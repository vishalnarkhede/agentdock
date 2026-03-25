import { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef, useMemo } from "react";
import { fetchFsDir, fetchFsFile, searchFsFiles } from "../api";
import type { FsEntry } from "../api";
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

interface SearchResult {
  path: string;
  name: string;
  type: "file" | "dir";
}

// Map of dirPath → entries (only what's been expanded)
type DirContents = Map<string, FsEntry[]>;

function getBasename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

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
  depth: number;
}

function TreeNode({
  path, name, type, ext,
  dirContents, expandedDirs, loadingPath, openFilePath,
  onToggleDir, onOpenFile, depth,
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
      >
        {type === "dir" ? (
          <span className={`fe-dir-arrow${isExpanded ? " fe-dir-arrow-open" : ""}`}>▶</span>
        ) : (
          <span className="fe-icon fe-icon-file">{ext ? ext.slice(1, 3).toUpperCase() : "··"}</span>
        )}
        <span className="fe-tree-name">{name}</span>
        {isLoading && <span className="fe-spinner">…</span>}
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

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({ roots, onClose }, ref) {
  const [dirContents, setDirContents] = useState<DirContents>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // File search (Cmd+F)
  const [fileSearchActive, setFileSearchActive] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [fileSearchMatchCount, setFileSearchMatchCount] = useState(0);
  const [fileSearchIdx, setFileSearchIdx] = useState(0);
  const fileContentRef = useRef<HTMLPreElement>(null);
  const fileSearchInputRef = useRef<HTMLInputElement>(null);

  // Filename search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [focusedResultIdx, setFocusedResultIdx] = useState<number>(-1);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusSearch: () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  }));

  // Cmd+F to open in-file search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f" && openFile) {
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

    // Clear existing marks
    pre.querySelectorAll("mark.fe-match").forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        parent.normalize();
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
    marks[clampedIdx]?.scrollIntoView({ block: "nearest" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFile, fileSearchQuery, fileSearchActive]);

  // Sync active mark when index changes
  useEffect(() => {
    const pre = fileContentRef.current;
    if (!pre) return;
    const marks = Array.from(pre.querySelectorAll<HTMLElement>("mark.fe-match"));
    marks.forEach((m, i) => m.classList.toggle("fe-match-active", i === fileSearchIdx));
    marks[fileSearchIdx]?.scrollIntoView({ block: "nearest" });
  }, [fileSearchIdx]);

  const closeFileSearch = useCallback(() => {
    setFileSearchActive(false);
    setFileSearchQuery("");
  }, []);

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

  // Debounced search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    searchTimeout.current = setTimeout(async () => {
      setSearchLoading(true);
      setError(null);
      try {
        const results = await searchFsFiles(searchQuery.trim(), roots);
        setSearchResults(results);
      } catch (err: any) {
        setError(err.message || "Search failed");
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, roots.join(",")]); // roots.join avoids re-running when array ref changes but content is same

  // Reset focused result when results change
  useEffect(() => {
    setFocusedResultIdx(-1);
  }, [searchResults]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (searchQuery) {
        setSearchQuery("");
      } else {
        onClose?.();
      }
      return;
    }
    if (!searchResults || searchResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedResultIdx((i) => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedResultIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx = focusedResultIdx >= 0 ? focusedResultIdx : 0;
      const result = searchResults[idx];
      if (result) {
        if (result.type === "file") handleOpenFile(result.path);
        else handleToggleDir(result.path);
      }
    }
  }, [searchQuery, searchResults, focusedResultIdx, onClose]);

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

  const openFilePath = openFile?.path ?? null;

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
      <div className="fe-tree-panel">
        <div className="fe-search-bar">
          <input
            ref={searchInputRef}
            className="fe-search-input"
            type="text"
            placeholder="⌘P — search files…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {searchQuery && (
            <button className="fe-search-clear" onClick={() => setSearchQuery("")}>×</button>
          )}
        </div>

        {searchQuery ? (
          <div className="fe-search-results">
            {searchLoading && <div className="fe-tree-empty" style={{ padding: "8px 12px" }}>searching…</div>}
            {!searchLoading && searchResults !== null && searchResults.length === 0 && (
              <div className="fe-tree-empty" style={{ padding: "8px 12px" }}>no matches</div>
            )}
            {searchResults?.map((result, idx) => (
              <div
                key={result.path}
                className={`fe-tree-item fe-search-result${openFilePath === result.path || focusedResultIdx === idx ? " fe-tree-item-active" : ""}`}
                onClick={() => result.type === "file" ? handleOpenFile(result.path) : handleToggleDir(result.path)}
                title={result.path}
              >
                <span className="fe-icon fe-icon-file" style={{ color: result.type === "dir" ? "var(--accent)" : undefined }}>
                  {result.type === "dir" ? "DIR" : result.name.includes(".") ? result.name.split(".").pop()!.slice(0, 2).toUpperCase() : "··"}
                </span>
                <div className="fe-search-result-text">
                  <span className="fe-tree-name">{result.name}</span>
                  <span className="fe-search-result-path">{getBreadcrumb(result.path)}</span>
                </div>
              </div>
            ))}
            {searchResults && searchResults.length === 100 && (
              <div className="fe-tree-empty" style={{ padding: "4px 12px", fontSize: "11px" }}>showing first 100 results</div>
            )}
          </div>
        ) : (
          <div className="fe-tree-body">
            {roots.map((root) => (
              <div key={root} className="fe-root-section">
                <div
                  className="fe-root-header"
                  onClick={() => handleToggleDir(root)}
                >
                  <span className={`fe-dir-arrow${expandedDirs.has(root) ? " fe-dir-arrow-open" : ""}`}>▶</span>
                  <span className="fe-root-name">{getBasename(root)}</span>
                  {loadingPath === root && <span className="fe-spinner">…</span>}
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
        )}
      </div>

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
                <button className="fe-file-search-close" onClick={closeFileSearch} title="Close (Esc)">×</button>
              </div>
            )}
            <pre ref={fileContentRef} className="fe-file-content"><code
              className={`hljs language-${openFile.language}`}
              dangerouslySetInnerHTML={{ __html: highlight(openFile.content, openFile.language) }}
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
