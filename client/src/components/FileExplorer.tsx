import { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { fetchFsDir, fetchFsFile, searchFsFiles } from "../api";
import type { FsEntry } from "../api";

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

  // Search state
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
    } else if (e.key === "Escape") {
      if (searchQuery) {
        setSearchQuery("");
      } else {
        onClose?.();
      }
    }
  }, [searchResults, focusedResultIdx]);

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
            </div>
            <pre className={`fe-file-content language-${openFile.language}`}><code>{openFile.content}</code></pre>
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
