import { useMemo, useState, type ReactNode } from "react";
import "../styles/mobile.css";

/** Buckets the queue can show. Wider than the four the phone filters on:
 *  `computeBucket()` in queue.ts can also return "stale", and a caller
 *  should not have to narrow before rendering. */
export type MobileQueueBucket = "blocked" | "review" | "working" | "idle" | "stale";

export interface MobileQueueRow {
  /** tmux session name — what onOpen/onAction are called with. */
  name: string;
  /** Name as shown to the reader, without the agent prefix. */
  displayName: string;
  bucket: MobileQueueBucket;
  /** Pre-formatted elapsed time, e.g. "25m". */
  age: string;
  repo: string;
  /** One line of what this session needs, in plain words. */
  line: string;
  /** Label for the row's action button — "Answer", "Approve", "Review".
   *  Omit it and the row has no button. */
  cta?: string;
}

export interface MobileQueueProps {
  rows: MobileQueueRow[];
  onOpen: (name: string) => void;
  onAction: (name: string, cta: string) => void;
  /** Sort/group control. The sidebar copy sits behind this overlay on a phone,
      so without it grouping cannot be changed there at all. */
  modeControl?: ReactNode;
}

type FilterId = "all" | "blocked" | "review" | "working";

const BUCKET_RANK: Record<MobileQueueBucket, number> = {
  blocked: 0,
  review: 1,
  working: 2,
  idle: 3,
  stale: 4,
};

const FILTERS: { id: FilterId; label: string; dot?: string }[] = [
  { id: "all", label: "All" },
  { id: "blocked", label: "Waiting", dot: "var(--status-blocked)" },
  { id: "review", label: "Review", dot: "var(--status-ready)" },
  { id: "working", label: "Working", dot: "var(--status-working)" },
];

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

/** The headline states the situation in a sentence so the answer arrives
 *  before any counting. Blocked work leads, because it is the only thing the
 *  phone can fix that the desktop cannot. */
function situation(counts: Record<FilterId, number>, total: number) {
  const { blocked, review, working } = counts;

  if (blocked > 0) {
    const rest = [
      review > 0 ? `${review} more ready to review` : "",
      working > 0 ? `${working} still working` : "",
    ].filter(Boolean);
    return {
      headline: `${blocked} ${plural(blocked, "agent is", "agents are")} waiting on you`,
      subline: rest.length > 0 ? `${rest.join(", ")}.` : "Nothing else is running.",
    };
  }

  if (review > 0) {
    return {
      headline: `${review} ${plural(review, "session is", "sessions are")} ready to review`,
      subline: working > 0 ? `${working} still working. Nothing is blocked.` : "Nothing is blocked.",
    };
  }

  if (working > 0) {
    return {
      headline: `${working} ${plural(working, "agent is", "agents are")} working`,
      subline: "Nothing needs you yet.",
    };
  }

  if (total > 0) {
    return {
      headline: "Nothing needs you",
      subline: `${total} idle ${plural(total, "session", "sessions")}.`,
    };
  }

  return { headline: "No agents running", subline: "Nothing to unblock." };
}

/**
 * The queue, for a phone.
 *
 * The phone has exactly one job the desktop cannot do: unblock an agent while
 * you are away from the machine. So each card carries its action inline —
 * Answer, Approve, Review — and you never have to open a session to act on it.
 * Working agents are present, but they are the quiet part of the list.
 *
 * Takes rows in; fetches nothing.
 */
export function MobileQueue({ rows, onOpen, onAction, modeControl }: MobileQueueProps) {
  const [filter, setFilter] = useState<FilterId>("all");

  const counts = useMemo(() => {
    const c: Record<FilterId, number> = { all: rows.length, blocked: 0, review: 0, working: 0 };
    for (const r of rows) {
      if (r.bucket === "blocked") c.blocked += 1;
      else if (r.bucket === "review") c.review += 1;
      else if (r.bucket === "working") c.working += 1;
    }
    return c;
  }, [rows]);

  /* Stable sort by bucket, so blocked leads whatever order the caller used
     and ordering inside a bucket stays the caller's. */
  const shown = useMemo(() => {
    const picked = filter === "all" ? rows : rows.filter((r) => r.bucket === filter);
    return picked
      .map((r, i) => ({ r, i }))
      .sort((a, b) => BUCKET_RANK[a.r.bucket] - BUCKET_RANK[b.r.bucket] || a.i - b.i)
      .map((x) => x.r);
  }, [rows, filter]);

  const { headline, subline } = situation(counts, rows.length);

  return (
    <div className="mq">
      <div className="mq-head">
        <h1 className="mq-headline">{headline}</h1>
        <p className="mq-subline">{subline}</p>
      </div>

      {modeControl && <div className="mq-mode-row">{modeControl}</div>}

      <div className="mq-filters" role="group" aria-label="Filter the queue">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="mq-chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.dot && <span className="mq-chip-dot" style={{ background: f.dot }} aria-hidden="true" />}
            {f.label}
            <span className="mq-chip-count">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="mq-empty">
          {rows.length === 0
            ? "No sessions yet."
            : `Nothing in ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()}.`}
        </p>
      ) : (
        <ul className="mq-list">
          {shown.map((r) => (
            <li key={r.name} className="mq-row" data-bucket={r.bucket} data-cta={Boolean(r.cta)}>
              <button
                type="button"
                className="mq-row-open"
                aria-label={`Open ${r.displayName}`}
                onClick={() => onOpen(r.name)}
              />
              <div className="mq-row-body">
                <div className="mq-row-top">
                  <span className="mq-dot" data-bucket={r.bucket} aria-hidden="true" />
                  <span className="mq-row-name">{r.displayName}</span>
                  <span className="mq-row-age">{r.age}</span>
                </div>
                <div className="mq-row-line">{r.line}</div>
                <div className="mq-row-foot">
                  <span className="mq-row-repo">{r.repo}</span>
                  {r.cta && (
                    <button
                      type="button"
                      className="mq-row-cta"
                      aria-label={`${r.cta} — ${r.displayName}`}
                      onClick={() => onAction(r.name, r.cta as string)}
                    >
                      {r.cta}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
