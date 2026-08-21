import { useState } from "react";
import { Icon } from "./Icon";
import "../styles/blocked.css";

/**
 * The card a session shows when it cannot continue without you.
 *
 * A blocked agent costs more than a slow one, so the ask leads and the
 * evidence sits beside it: the plan step it serves, the file it touches and
 * what you already allowed here. Every button the agent offered is a button
 * here, and there is always a way to answer in your own words instead — a
 * fixed set of choices is a guess about the question, not about the answer.
 *
 * Presentation only. The parent owns sending the answer.
 */

export interface BlockedCardProps {
  sessionName: string;
  displayName: string;
  mode: "permission" | "question";
  waited: string;
  question: string;
  detail?: string;
  choices: { label: string; kind: "primary" | "plain" | "danger" }[];
  replyPlaceholder: string;
  diff?: { path: string; plus: number; minus: number; lines: { sign: " " | "+" | "-"; text: string }[] };
  context: { label: string; text: string; sub?: string; warn?: boolean }[];
  rememberLabel?: string;
  rememberNote?: string;
  onAnswer: (text: string) => void;
  onChoice: (label: string) => void;
  onRemember?: (on: boolean) => void;
}

const SIGN_CLASS: Record<string, string> = { "+": "blk-dl-add", "-": "blk-dl-del", " ": "" };

/** A single path-like token reads better in mono; a sentence does not. */
const isPathish = (text: string) => /^\S+$/.test(text) && /[/.]/.test(text);

export function BlockedCard({
  sessionName,
  displayName,
  mode,
  waited,
  question,
  detail,
  choices,
  replyPlaceholder,
  diff,
  context,
  rememberLabel,
  rememberNote,
  onAnswer,
  onChoice,
  onRemember,
}: BlockedCardProps) {
  const [reply, setReply] = useState("");
  const [remember, setRemember] = useState(false);
  const replyId = `blk-reply-${sessionName}`;

  const meta =
    mode === "permission"
      ? diff
        ? "Edit · 1 file"
        : ""
      : `Open question · asked ${waited} ago`;

  const send = () => {
    const text = reply.trim();
    if (!text) return;
    onAnswer(text);
    setReply("");
  };

  const toggleRemember = (on: boolean) => {
    setRemember(on);
    onRemember?.(on);
  };

  return (
    <section className="blk" aria-label={`${displayName} is waiting on you`}>
      <div className="blk-layout">
        <div className="blk-card">
          <div className="blk-card-head">
            <span className="blk-pulse" aria-hidden="true" />
            <span className="blk-kind">{mode === "permission" ? "PERMISSION" : "QUESTION"}</span>
            {meta && <span className="blk-card-meta">{meta}</span>}
          </div>

          <div className="blk-ask">
            <div className="blk-question">{question}</div>
            {detail && <p className="blk-detail">{detail}</p>}
          </div>

          {diff && (
            <div className="blk-diff">
              <div className="blk-diff-head">
                <span className="blk-diff-path">{diff.path}</span>
                <span className="blk-diff-stat">
                  +{diff.plus} &minus;{diff.minus}
                </span>
              </div>
              {diff.lines.map((l, i) => (
                <div key={i} className={`blk-dl ${SIGN_CLASS[l.sign]}`}>
                  <span className="blk-dl-sign" aria-hidden="true">{l.sign}</span>
                  <span className="blk-dl-text">{l.text}</span>
                </div>
              ))}
            </div>
          )}

          <div className="blk-actions">
            {choices.map((c) => (
              <button
                key={c.label}
                type="button"
                className={`blk-btn blk-btn-${c.kind}`}
                onClick={() => onChoice(c.label)}
              >
                {c.label}
              </button>
            ))}
            <div className="blk-reply">
              <label className="blk-sr" htmlFor={replyId}>
                Your answer to {displayName}
              </label>
              <input
                id={replyId}
                className="blk-reply-input"
                type="text"
                value={reply}
                placeholder={replyPlaceholder}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <span className="blk-key" aria-hidden="true">&#8629;</span>
            </div>
          </div>

          {rememberLabel && (
            <label className="blk-remember">
              <input
                className="blk-sr"
                type="checkbox"
                checked={remember}
                onChange={(e) => toggleRemember(e.target.checked)}
              />
              <span className="blk-box" aria-hidden="true">
                {remember && <Icon name="check" size={12} />}
              </span>
              <span className="blk-remember-label">{rememberLabel}</span>
              {rememberNote && <span className="blk-remember-note">{rememberNote}</span>}
            </label>
          )}
        </div>

        <aside className="blk-context">
          <div className="blk-context-head">WHAT YOU NEED TO DECIDE WELL</div>
          <div className="blk-context-body">
            {context.map((c) => (
              <div key={c.label}>
                <div className="blk-ctx-label">{c.label}</div>
                <div className={`blk-ctx-box${c.warn ? " blk-ctx-warn" : ""}`}>
                  <div className={`blk-ctx-text${isPathish(c.text) ? " blk-ctx-mono" : ""}`}>
                    {c.text}
                  </div>
                  {c.sub && <div className="blk-ctx-sub">{c.sub}</div>}
                </div>
              </div>
            ))}
          </div>
          <div className="blk-notified">
            <Icon name="bell" size={14} className="blk-notified-icon" />
            <span className="blk-notified-text">You were notified {waited} ago</span>
            <button type="button" className="blk-link">Notification settings</button>
          </div>
        </aside>
      </div>
    </section>
  );
}
