import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from "react";
import { Icon } from "./Icon";
import { find, indexStatus, EMPTY_FIND, type FindResult, type FileHit, type ContentHit } from "../search-api";
import "../styles/file-search.css";

/**
 * Filenames come from an in-memory index and answer in single-digit
 * milliseconds; content search spawns a process and takes hundreds. Debouncing
 * them together would hold the fast half hostage to the slow one.
 */
const NAME_DEBOUNCE = 45;
const CONTENT_DEBOUNCE = 160;
const LIMIT = 200;

export interface FileSearchHandle {
  focus: () => void;
}

interface Props {
  roots: string[];
  onOpenFile: (path: string, line?: number, term?: string) => void;
  activePath?: string | null;
  /** Shown in place of results when the query is empty — the file tree. */
  children?: React.ReactNode;
}

type Row =
  | { kind: "file"; hit: FileHit }
  | { kind: "content"; hit: ContentHit };

interface ContentGroup {
  path: string;
  rel: string;
  hits: ContentHit[];
}

/** One header per file instead of the path repeated on every matching line. */
export function groupByFile(hits: ContentHit[]): ContentGroup[] {
  const out: ContentGroup[] = [];
  let cur: ContentGroup | null = null;
  for (const h of hits) {
    if (!cur || cur.path !== h.path) {
      cur = { path: h.path, rel: h.rel, hits: [] };
      out.push(cur);
    }
    cur.hits.push(h);
  }
  return out;
}

interface Options {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

const OPTIONS_KEY = "agentdock:search-options";

function loadOptions(): Options {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) return { regex: false, caseSensitive: false, wholeWord: false, ...JSON.parse(raw) };
  } catch { /* fall through to defaults */ }
  return { regex: false, caseSensitive: false, wholeWord: false };
}

/** Split `text` into matched/unmatched runs at the given character indices. */
function markPositions(text: string, positions: number[]): { s: string; hit: boolean }[] {
  if (positions.length === 0) return [{ s: text, hit: false }];
  const set = new Set(positions);
  const out: { s: string; hit: boolean }[] = [];
  let cur = "";
  let curHit = set.has(0);
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== curHit) {
      if (cur) out.push({ s: cur, hit: curHit });
      cur = "";
      curHit = h;
    }
    cur += text[i];
  }
  if (cur) out.push({ s: cur, hit: curHit });
  return out;
}

function markRange(text: string, col: number, len: number): { s: string; hit: boolean }[] {
  const start = Math.max(0, col - 1);
  const end = Math.min(text.length, start + len);
  if (len <= 0 || start >= text.length) return [{ s: text, hit: false }];
  return [
    { s: text.slice(0, start), hit: false },
    { s: text.slice(start, end), hit: true },
    { s: text.slice(end), hit: false },
  ].filter((p) => p.s.length > 0);
}

function Marked({ parts }: { parts: { s: string; hit: boolean }[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? <mark key={i} className="fsx-mark">{p.s}</mark> : <span key={i}>{p.s}</span>,
      )}
    </>
  );
}

export const FileSearch = forwardRef<FileSearchHandle, Props>(function FileSearch(
  { roots, onOpenFile, activePath, children },
  ref,
) {
  const [query, setQuery] = useState("");
  const [names, setNames] = useState<FindResult>(EMPTY_FIND);
  const [content, setContent] = useState<FindResult>(EMPTY_FIND);
  const [namesBusy, setNamesBusy] = useState(false);
  const [contentBusy, setContentBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opts, setOpts] = useState<Options>(loadOptions);
  const [showOpts, setShowOpts] = useState(false);
  const [cursor, setCursor] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Abort is not instantaneous, so a sequence number decides which response is
  // allowed to render. Without it, fast typing lands results out of order and
  // the list shows answers to a query the user has already replaced.
  const nameSeq = useRef(0);
  const contentSeq = useRef(0);
  const nameAbort = useRef<AbortController | null>(null);
  const contentAbort = useRef<AbortController | null>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }));

  useEffect(() => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
    } catch { /* storage unavailable — options just will not persist */ }
  }, [opts]);

  const rootsKey = roots.join(",");

  // Build the index before the first keystroke, so opening Files and typing
  // immediately does not pay for the cold build.
  const [indexed, setIndexed] = useState(0);
  useEffect(() => {
    if (roots.length === 0) return;
    let alive = true;
    indexStatus(roots)
      .then((rs) => {
        if (alive) setIndexed(rs.reduce((n, r) => n + r.count, 0));
      })
      .catch(() => { /* status is a nicety; search still works without it */ });
    return () => { alive = false; };
  }, [rootsKey]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      nameAbort.current?.abort();
      setNames(EMPTY_FIND);
      setNamesBusy(false);
      return;
    }
    setNamesBusy(true);
    const seq = ++nameSeq.current;
    const timer = setTimeout(() => {
      nameAbort.current?.abort();
      const ac = new AbortController();
      nameAbort.current = ac;
      find(q, roots, { kind: "name", limit: LIMIT, signal: ac.signal })
        .then((r) => {
          if (seq !== nameSeq.current) return;
          setNames(r);
          setNamesBusy(false);
        })
        .catch((e) => {
          if (e?.name === "AbortError" || seq !== nameSeq.current) return;
          setNamesBusy(false);
        });
    }, NAME_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [query, rootsKey]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      contentAbort.current?.abort();
      setContent(EMPTY_FIND);
      setContentBusy(false);
      setError(null);
      return;
    }
    setContentBusy(true);
    const seq = ++contentSeq.current;
    const timer = setTimeout(() => {
      contentAbort.current?.abort();
      const ac = new AbortController();
      contentAbort.current = ac;
      find(q, roots, {
        kind: "content",
        limit: LIMIT,
        regex: opts.regex,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        signal: ac.signal,
      })
        .then((r) => {
          if (seq !== contentSeq.current) return;
          setContent(r);
          setContentBusy(false);
          setError(null);
        })
        .catch((e) => {
          if (e?.name === "AbortError" || seq !== contentSeq.current) return;
          setContentBusy(false);
          setError(opts.regex ? "invalid pattern" : "search failed");
        });
    }, CONTENT_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [query, rootsKey, opts.regex, opts.caseSensitive, opts.wholeWord]);

  useEffect(() => () => {
    nameAbort.current?.abort();
    contentAbort.current?.abort();
  }, []);

  const groups = useMemo(() => groupByFile(content.content), [content.content]);

  const rows: Row[] = useMemo(() => {
    const f: Row[] = names.files.map((hit) => ({ kind: "file" as const, hit }));
    const c: Row[] = content.content.map((hit) => ({ kind: "content" as const, hit }));
    return [...f, ...c];
  }, [names.files, content.content]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    if (cursor < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, rows.length]);

  const open = useCallback(
    (row: Row) => {
      if (row.kind === "file") onOpenFile(row.hit.path);
      else onOpenFile(row.hit.path, row.hit.line);
    },
    [onOpenFile],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor];
      if (row) open(row);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else inputRef.current?.blur();
    }
  };

  const busy = namesBusy || contentBusy;
  const q = query.trim();
  const nothing = q && !busy && rows.length === 0;
  const queryLen = q.length;

  const status = (() => {
    if (!q) {
      const n = indexed || names.indexed || content.indexed;
      return n > 0 ? `${n.toLocaleString()} files indexed` : "";
    }
    if (rows.length === 0) return busy ? "searching…" : "";
    const parts = [`${names.files.length}${names.truncated.files ? "+" : ""} files`];
    parts.push(`${content.content.length}${content.truncated.content ? "+" : ""} matches`);
    if (!busy) parts.push(`${Math.max(names.tookMs, content.tookMs)}ms`);
    return parts.join(" · ");
  })();

  const toggle = (k: keyof Options) => setOpts((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div className="fsx">
      <div className="fsx-bar">
        <Icon name="search" size={13} />
        <input
          ref={inputRef}
          className="fsx-input"
          placeholder="Find files and text…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {query && (
          <button className="fsx-clear" onClick={() => setQuery("")} title="Clear (Esc)" aria-label="Clear search">
            ×
          </button>
        )}
        <button
          className={`fsx-optbtn${showOpts ? " fsx-optbtn-on" : ""}${opts.regex || opts.caseSensitive || opts.wholeWord ? " fsx-optbtn-dirty" : ""}`}
          onClick={() => setShowOpts((v) => !v)}
          title="Search options"
          aria-expanded={showOpts}
        >
          <Icon name="filter" size={13} />
        </button>
      </div>

      {showOpts && (
        <div className="fsx-opts" role="group" aria-label="Search options">
          <button className={`fsx-opt${opts.caseSensitive ? " fsx-opt-on" : ""}`} onClick={() => toggle("caseSensitive")} aria-pressed={opts.caseSensitive}>
            Aa<span className="fsx-opt-label">case</span>
          </button>
          <button className={`fsx-opt${opts.wholeWord ? " fsx-opt-on" : ""}`} onClick={() => toggle("wholeWord")} aria-pressed={opts.wholeWord}>
            ab<span className="fsx-opt-label">word</span>
          </button>
          <button className={`fsx-opt${opts.regex ? " fsx-opt-on" : ""}`} onClick={() => toggle("regex")} aria-pressed={opts.regex}>
            .*<span className="fsx-opt-label">regex</span>
          </button>
        </div>
      )}

      {!q && children ? (
        <div className="fsx-idle">{children}</div>
      ) : (
        <>
      <div className="fsx-status">
        <span>{status}</span>
        {busy && <span className="fsx-spin" aria-label="searching" />}
      </div>

      {error && <div className="fsx-error">{error}</div>}

      <div className="fsx-list" ref={listRef} role="listbox" aria-label="Search results">
        {names.files.length > 0 && (
          <div className="fsx-group">
            <div className="fsx-group-head">
              files<span className="fsx-group-count">{names.files.length}{names.truncated.files ? "+" : ""}</span>
            </div>
            {names.files.map((hit, i) => (
              <button
                key={`f:${hit.path}`}
                data-row={i}
                role="option"
                aria-selected={cursor === i}
                className={`fsx-row${cursor === i ? " fsx-row-cursor" : ""}${activePath === hit.path ? " fsx-row-active" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onOpenFile(hit.path)}
              >
                <span className="fsx-name">
                  <Marked parts={markPositions(hit.name, hit.positions.map((p) => p - (hit.rel.length - hit.name.length)).filter((p) => p >= 0))} />
                </span>
                <span className="fsx-dir">{hit.rel.slice(0, Math.max(0, hit.rel.length - hit.name.length))}</span>
              </button>
            ))}
          </div>
        )}

        {groups.length > 0 && (
          <div className="fsx-group">
            <div className="fsx-group-head">
              in files
              <span className="fsx-group-count">
                {content.content.length}{content.truncated.content ? "+" : ""} in {groups.length} file{groups.length === 1 ? "" : "s"}
              </span>
            </div>
            {(() => {
              let i = names.files.length - 1;
              return groups.map((g) => (
                <div key={g.path} className="fsx-filegroup">
                  <button
                    className="fsx-filegroup-head"
                    onClick={() => onOpenFile(g.path)}
                    title={g.path}
                  >
                    <span className="fsx-filegroup-name">{g.rel.split("/").pop()}</span>
                    <span className="fsx-filegroup-dir">{g.rel.slice(0, Math.max(0, g.rel.length - (g.rel.split("/").pop()?.length ?? 0)))}</span>
                    <span className="fsx-filegroup-count">{g.hits.length}</span>
                  </button>
                  {g.hits.map((hit) => {
                    i += 1;
                    const idx = i;
                    return (
                      <button
                        key={`${hit.line}:${hit.col}`}
                        data-row={idx}
                        role="option"
                        aria-selected={cursor === idx}
                        className={`fsx-hit${cursor === idx ? " fsx-hit-cursor" : ""}`}
                        onMouseEnter={() => setCursor(idx)}
                        onClick={() => onOpenFile(hit.path, hit.line, q)}
                      >
                        <span className="fsx-hit-line">{hit.line}</span>
                        <span className="fsx-hit-code">
                          <Marked parts={markRange(hit.text, hit.col, queryLen)} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        )}

        {nothing && <div className="fsx-empty">No matches for “{q}”</div>}
        {!q && !children && <div className="fsx-hint">↑↓ move · ⏎ open · esc clear</div>}
      </div>
        </>
      )}
    </div>
  );
});
