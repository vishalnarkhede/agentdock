import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { PlanInline } from "./PlanInline";
import { sendSessionInput } from "../api";
import {
  createPlanComment,
  fetchPlanComments,
  fetchPlanDoc,
  patchPlanComment,
  removePlanComment,
  type PlanComment,
} from "../plan-api";
import { parsePlan, planProgress, planOutline, type PlanBlock } from "../plan-blocks";
import "../styles/plan-view.css";

const POLL_MS = 4000;

/** Stable identity, so a block with no comments never re-renders on a poll. */
const EMPTY_COMMENTS: PlanComment[] = [];


/** Cheap structural compare — avoids a re-render when a poll changes nothing. */
export function sameComments(a: PlanComment[], b: PlanComment[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.body !== y.body ||
      x.blockId !== y.blockId ||
      x.resolvedAt !== y.resolvedAt ||
      x.sentAt !== y.sentAt ||
      !!x.orphaned !== !!y.orphaned
    ) {
      return false;
    }
  }
  return true;
}

interface Props {
  sessionName: string;
  viewMode: "rendered" | "raw";
}

interface BlockRowProps {
  block: PlanBlock;
  focused: boolean;
  comments: PlanComment[];
  composing: boolean;
  onFocus: (blockId: string) => void;
  onStartComment: (blockId: string) => void;
  onCancelComment: () => void;
  onSubmitComment: (block: PlanBlock, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}

const BlockRow = memo(function BlockRow({
  block,
  focused,
  comments,
  composing,
  onFocus,
  onStartComment,
  onCancelComment,
  onSubmitComment,
  onResolve,
  onDelete,
}: BlockRowProps) {
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (composing) {
      setDraft("");
      taRef.current?.focus();
    }
  }, [composing]);

  const open = comments.filter((c) => !c.resolvedAt);
  const resolved = comments.filter((c) => c.resolvedAt);

  const body = (() => {
    const t = block.text;
    switch (block.kind) {
      case "heading": {
        const H = `h${Math.min(block.level + 1, 6)}` as "h2";
        return <H className={`pv-h pv-h${block.level}`}><PlanInline text={t.replace(/^#+\s*/, "")} /></H>;
      }
      case "list": {
        const stripped = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\[[ xX~/-]\]\s*/, "");
        return (
          <div className="pv-li" style={{ paddingLeft: `${block.level * 16}px` }}>
            {block.checked === null ? (
              <span className="pv-bullet">•</span>
            ) : (
              // Read-only: the agent rewrites this file with [x] on every step,
              // so writing back here would clobber its state and ours in turn.
              <span
                className={`pv-box${block.checked ? " pv-box-on" : ""}`}
                role="img"
                aria-label={block.checked ? "done" : "not done"}
              >
                {block.checked ? "✓" : ""}
              </span>
            )}
            <span className={block.checked ? "pv-li-done" : undefined}>
              <PlanInline text={stripped} />
            </span>
          </div>
        );
      }
      case "code":
        return <pre className="pv-pre">{t}</pre>;
      case "quote":
        return <blockquote className="pv-quote"><PlanInline text={t.replace(/^>\s?/, "")} /></blockquote>;
      case "rule":
        return <hr className="pv-rule" />;
      case "table":
        return <div className="pv-table-row">{t}</div>;
      default:
        return <p className="pv-p"><PlanInline text={t} /></p>;
    }
  })();

  return (
    <div
      className={`pv-block${focused ? " pv-block-focus" : ""}${open.length ? " pv-block-commented" : ""}`}
      data-block={block.id}
      onMouseEnter={() => onFocus(block.id)}
    >
      <div className="pv-gutter">
        <button
          className="pv-gutter-btn"
          tabIndex={-1}
          aria-label="Comment on this"
          title="Comment (c)"
          onClick={() => onStartComment(block.id)}
        >
          +
        </button>
        {open.length > 0 && <span className="pv-gutter-count">{open.length}</span>}
      </div>

      <div className="pv-body">
        {body}

        {(open.length > 0 || resolved.length > 0) && (
          <div className="pv-threads">
            {[...open, ...resolved].map((c) => (
              <div key={c.id} className={`pv-thread${c.resolvedAt ? " pv-thread-resolved" : ""}`}>
                <div className="pv-thread-head">
                  <span className="pv-thread-meta">
                    {c.orphaned && (
                      <span className="pv-orphan" title="The text this was written against has since been rewritten">
                        outdated
                      </span>
                    )}
                    {c.sentAt ? <span className="pv-sent">sent</span> : null}
                  </span>
                  <span className="pv-thread-actions">
                    <button onClick={() => onResolve(c.id, !c.resolvedAt)} title={c.resolvedAt ? "Reopen" : "Resolve"}>
                      {c.resolvedAt ? "reopen" : "resolve"}
                    </button>
                    <button onClick={() => onDelete(c.id)} title="Delete">delete</button>
                  </span>
                </div>
                <div className="pv-thread-body">{c.body}</div>
              </div>
            ))}
          </div>
        )}

        {composing && (
          <div className="pv-composer">
            <textarea
              ref={taRef}
              className="pv-composer-input"
              placeholder="Comment on this step…  ⌘↵ to save, esc to cancel"
              value={draft}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCancelComment();
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (draft.trim()) onSubmitComment(block, draft.trim());
                }
              }}
            />
            <div className="pv-composer-actions">
              <button className="pv-btn pv-btn-primary" disabled={!draft.trim()} onClick={() => draft.trim() && onSubmitComment(block, draft.trim())}>
                Comment
              </button>
              <button className="pv-btn" onClick={onCancelComment}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export function PlanView({ sessionName, viewMode }: Props) {
  const [plan, setPlan] = useState<string | null>(null);
  const [hash, setHash] = useState("");
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<PlanComment[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [composingId, setComposingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const hashRef = useRef("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const doc = await fetchPlanDoc(sessionName, hashRef.current || undefined);
      // The whole point: an unchanged plan must not touch state, or the block
      // tree remounts every poll and eats selection and open composers.
      if (!doc.unchanged) {
        hashRef.current = doc.hash;
        setPlan(doc.plan);
        setHash(doc.hash);
      }
    } catch {
      /* transient — the next tick retries */
    } finally {
      setLoading(false);
    }
  }, [sessionName]);

  const loadComments = useCallback(async () => {
    try {
      const next = await fetchPlanComments(sessionName);
      // Same reasoning as the plan hash: handing React a fresh array every
      // four seconds re-renders every block for nothing.
      setComments((prev) => (sameComments(prev, next) ? prev : next));
    } catch {
      /* comments are additive; the plan still renders without them */
    }
  }, [sessionName]);

  useEffect(() => {
    hashRef.current = "";
    setLoading(true);
    load();
    loadComments();
    const t = setInterval(() => {
      if (document.hidden) return;
      load();
      loadComments();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load, loadComments]);

  useEffect(() => {
    const handler = () => {
      if (!plan) return;
      const blob = new Blob([plan], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${sessionName}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    window.addEventListener("plan-download", handler);
    return () => window.removeEventListener("plan-download", handler);
  }, [plan, sessionName]);

  const blocks = useMemo(() => (plan ? parsePlan(plan) : []), [plan]);
  const progress = useMemo(() => planProgress(blocks), [blocks]);
  const outline = useMemo(() => planOutline(blocks), [blocks]);

  const byBlock = useMemo(() => {
    const m = new Map<string, PlanComment[]>();
    for (const c of comments) {
      const arr = m.get(c.blockId) ?? [];
      arr.push(c);
      m.set(c.blockId, arr);
    }
    return m;
  }, [comments]);

  const orphans = useMemo(() => comments.filter((c) => c.orphaned && !c.resolvedAt), [comments]);
  const unsent = useMemo(() => comments.filter((c) => !c.sentAt && !c.resolvedAt), [comments]);

  const startComment = useCallback((id: string) => setComposingId(id), []);
  const cancelComment = useCallback(() => setComposingId(null), []);
  const focus = useCallback((id: string) => setFocusId(id), []);

  const submitComment = useCallback(
    async (block: PlanBlock, body: string) => {
      setComposingId(null);
      const created = await createPlanComment(sessionName, {
        blockId: block.id,
        anchorText: block.text,
        body,
      }).catch(() => null);
      if (created) setComments((prev) => [...prev, created]);
      else setNotice("Could not save that comment.");
    },
    [sessionName],
  );

  const resolve = useCallback(
    async (id: string, resolved: boolean) => {
      setComments((prev) => prev.map((c) => (c.id === id ? { ...c, resolvedAt: resolved ? Date.now() : undefined } : c)));
      await patchPlanComment(sessionName, id, { resolved });
    },
    [sessionName],
  );

  const del = useCallback(
    async (id: string) => {
      setComments((prev) => prev.filter((c) => c.id !== id));
      await removePlanComment(sessionName, id);
    },
    [sessionName],
  );

  const sendToAgent = useCallback(async () => {
    if (unsent.length === 0) return;
    setSending(true);
    try {
      const text = unsent
        .map((c) => `Regarding this part of the plan:\n\`\`\`\n${c.anchorText}\n\`\`\`\n${c.body}`)
        .join("\n\n");
      await sendSessionInput(sessionName, `Please address these plan comments:\n\n${text}`);
      const ids = unsent.map((c) => c.id);
      setComments((prev) => prev.map((c) => (ids.includes(c.id) ? { ...c, sentAt: Date.now() } : c)));
      await Promise.all(ids.map((id) => patchPlanComment(sessionName, id, { sent: true })));
    } catch {
      setNotice("Could not reach the agent.");
    } finally {
      setSending(false);
    }
  }, [unsent, sessionName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composingId) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (blocks.length === 0) return;

      const cur = blocks.findIndex((b) => b.id === focusId);
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocusId(blocks[Math.min(cur + 1, blocks.length - 1)]?.id ?? null);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusId(blocks[Math.max(cur - 1, 0)]?.id ?? null);
      } else if (e.key === "c" && focusId) {
        e.preventDefault();
        setComposingId(focusId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blocks, focusId, composingId]);

  useEffect(() => {
    if (!focusId || !scrollRef.current) return;
    scrollRef.current
      .querySelector<HTMLElement>(`[data-block="${CSS.escape(focusId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusId]);

  const jump = (id: string) => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-block="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  if (loading) return <div className="pv"><div className="pv-loading">Loading plan…</div></div>;

  if (!plan) {
    return (
      <div className="pv">
        <div className="pv-empty">
          <div className="pv-empty-title">No plan yet</div>
          <div className="pv-empty-sub">
            Ask the agent to write one — it saves to
            <code className="pv-code"> ~/.config/agentdock/plans/{sessionName}.md</code>
          </div>
        </div>
      </div>
    );
  }

  if (viewMode === "raw") {
    return (
      <div className="pv">
        <div className="pv-toolbar">
          <span className="pv-progress-text">raw markdown · {plan.split("\n").length} lines</span>
          <button className="pv-btn" onClick={() => navigator.clipboard?.writeText(plan)}>copy</button>
        </div>
        <pre className="pv-raw">{plan}</pre>
      </div>
    );
  }

  return (
    <div className="pv">
      <div className="pv-toolbar">
        {progress.total > 0 ? (
          <span className="pv-progress">
            <span className="pv-progress-bar" aria-hidden>
              <span className="pv-progress-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </span>
            <span className="pv-progress-text">
              {progress.done} of {progress.total} steps
            </span>
          </span>
        ) : (
          <span className="pv-progress-text">{blocks.length} blocks</span>
        )}

        {outline.length > 1 && (
          <select
            className="pv-jump"
            value=""
            onChange={(e) => { if (e.target.value) jump(e.target.value); }}
            aria-label="Jump to section"
          >
            <option value="">Jump to…</option>
            {outline.map((h) => (
              <option key={h.id} value={h.id}>
                {"  ".repeat(Math.max(0, h.level - 1))}{h.text.replace(/^#+\s*/, "")}
              </option>
            ))}
          </select>
        )}

        <span className="pv-toolbar-spacer" />
        <span className="pv-keyhint">j/k move · c comment</span>
      </div>

      {orphans.length > 0 && (
        <div className="pv-banner">
          <Icon name="alert" size={13} />
          {orphans.length} comment{orphans.length === 1 ? "" : "s"} on text the agent has since rewritten
        </div>
      )}

      {notice && (
        <div className="pv-banner pv-banner-error" role="alert">
          {notice}
          <button className="pv-banner-x" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="pv-doc" ref={scrollRef}>
        {blocks.map((b) => (
          <BlockRow
            key={b.id}
            block={b}
            focused={b.id === focusId}
            comments={byBlock.get(b.id) ?? EMPTY_COMMENTS}
            composing={composingId === b.id}
            onFocus={focus}
            onStartComment={startComment}
            onCancelComment={cancelComment}
            onSubmitComment={submitComment}
            onResolve={resolve}
            onDelete={del}
          />
        ))}
      </div>

      {unsent.length > 0 && (
        <div className="pv-batch">
          <span className="pv-batch-count">
            {unsent.length} comment{unsent.length === 1 ? "" : "s"} not sent
          </span>
          <button className="pv-btn pv-btn-primary" onClick={sendToAgent} disabled={sending}>
            {sending ? "sending…" : "Send to agent"}
          </button>
        </div>
      )}

      <span hidden data-plan-hash={hash} />
    </div>
  );
}
