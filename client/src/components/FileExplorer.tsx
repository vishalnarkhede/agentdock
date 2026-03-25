import { useState, useCallback } from "react";
import { fetchFsDir, fetchFsFile } from "../api";
import type { FsEntry } from "../api";

interface Props {
  sessionName: string;
  roots: string[]; // absolute paths to repo root(s)
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

function FileIcon({ type, ext }: { type: "file" | "dir"; ext?: string }) {
  if (type === "dir") return <span className="fe-icon fe-icon-dir">▶</span>;
  const icons: Record<string, string> = {
    ".ts": "TS", ".tsx": "TS", ".js": "JS", ".jsx": "JS",
    ".py": "PY", ".go": "GO", ".rs": "RS",
    ".json": "{}", ".md": "MD", ".css": "CSS",
    ".html": "HT", ".yml": "YL", ".yaml": "YL",
    ".sh": "SH", ".env": "EV",
  };
  const label = ext ? (icons[ext] || "··") : "··";
  return <span className="fe-icon fe-icon-file">{label}</span>;
}

interface TreeNodeProps {
  path: string;
  name: string;
  type: "file" | "dir";
  ext?: string;
  sessionName: string;
  dirContents: DirContents;
  expandedDirs: Set<string>;
  loadingPath: string | null;
  openFilePath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  depth: number;
}

function TreeNode({
  path, name, type, ext, sessionName,
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
          <FileIcon type={type} ext={ext} />
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
              sessionName={sessionName}
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

export function FileExplorer({ sessionName, roots }: Props) {
  const [dirContents, setDirContents] = useState<DirContents>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        const entries = await fetchFsDir(path, sessionName);
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
  }, [dirContents, sessionName]);

  const handleOpenFile = useCallback(async (path: string) => {
    if (openFile?.path === path) return;
    setLoadingPath(path);
    setError(null);
    try {
      const data = await fetchFsFile(path, sessionName);
      setOpenFile({ path, ...data });
    } catch (err: any) {
      setError(err.message || "Failed to read file");
    } finally {
      setLoadingPath(null);
    }
  }, [openFile, sessionName]);

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
                    sessionName={sessionName}
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
}
