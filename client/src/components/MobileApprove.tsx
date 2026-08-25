import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import "../styles/mobile.css";

export interface MobileApproveDiff {
  path: string;
  plus: number;
  minus: number;
  /** Context, added and removed lines, in file order. */
  lines: { sign: " " | "+" | "-"; text: string }[];
}

export interface MobileApproveProps {
  /** Session the request came from, shown as provenance. */
  displayName: string;
  /** Pre-formatted wait, e.g. "25m" — how long the agent has been stuck. */
  waited: string;
  /** The ask, phrased as a question. */
  question: string;
  /** One line of why it wants this. */
  detail?: string;
  /** The change the permission would allow, small enough to read on a phone. */
  diff?: MobileApproveDiff;
  /** Another session touching the same file, if there is one. */
  conflictWith?: string;
  onAllowOnce: () => void;
  onAllowSession: () => void;
  /** Called with the typed reason when the reader denies with one. */
  onDeny: (reason?: string) => void;
  onDismiss: () => void;
}

/**
 * The permission ask, as a bottom sheet.
 *
 * This is the screen the phone exists for. Everything needed to decide is
 * above the fold — what, why, the diff, and whether another session is about
 * to collide with it — and every action sits at the bottom of the sheet, in
 * thumb reach, largest first. The terminal keeps rendering underneath; this
 * only dims it.
 */
export function MobileApprove({
  displayName,
  waited,
  question,
  detail,
  diff,
  conflictWith,
  onAllowOnce,
  onAllowSession,
  onDeny,
  onDismiss,
}: MobileApproveProps) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  useEffect(() => {
    if (reasonOpen) reasonRef.current?.focus();
  }, [reasonOpen]);

  const submitReason = () => {
    const text = reason.trim();
    if (!text) return;
    onDeny(text);
  };

  return (
    <div className="ma">
      <button type="button" className="ma-scrim" aria-label="Dismiss without answering" onClick={onDismiss} />

      <div className="ma-sheet" role="dialog" aria-modal="true" aria-labelledby="ma-ask">
        <button type="button" className="ma-grab" aria-label="Dismiss without answering" onClick={onDismiss} />

        <div className="ma-body">
          <div className="ma-meta">
            <span className="mq-dot" data-bucket="blocked" aria-hidden="true" />
            <span className="ma-label">PERMISSION · {waited}</span>
            <span className="ma-who">{displayName}</span>
          </div>

          <h2 className="ma-ask" id="ma-ask">
            {question}
          </h2>
          {detail && <p className="ma-why">{detail}</p>}

          {diff && (
            <div className="ma-diff">
              <div className="ma-diff-head">
                <span className="ma-diff-path" title={diff.path}>
                  {diff.path}
                </span>
                <span className="ma-diff-stat">
                  <span className="ma-diff-plus">+{diff.plus}</span>{" "}
                  <span className="ma-diff-minus">−{diff.minus}</span>
                </span>
              </div>
              <div className="ma-diff-lines">
                {diff.lines.map((l, i) => (
                  <div className="ma-diff-line" data-sign={l.sign} key={i}>
                    <span className="ma-diff-sign">{l.sign}</span>
                    <span>{l.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {conflictWith && (
            <div className="ma-conflict">
              <span className="ma-conflict-icon">
                <Icon name="alert" size={14} />
              </span>
              <span className="ma-conflict-text">
                {conflictWith} also changes this file. Whichever merges second will have to resolve it.
              </span>
            </div>
          )}
        </div>

        <div className="ma-actions">
          <button type="button" className="ma-btn ma-btn-primary" onClick={onAllowOnce}>
            Allow once
          </button>

          <div className="ma-btn-row">
            <button type="button" className="ma-btn" onClick={onAllowSession}>
              Allow all session
            </button>
            <button type="button" className="ma-btn ma-btn-danger" onClick={() => onDeny()}>
              Deny
            </button>
          </div>

          <button
            type="button"
            className="ma-reason-toggle"
            aria-expanded={reasonOpen}
            onClick={() => setReasonOpen((v) => !v)}
          >
            {reasonOpen ? "Never mind" : "Deny with a reason instead"}
          </button>

          {reasonOpen && (
            <div className="ma-reason">
              <input
                ref={reasonRef}
                className="ma-reason-input"
                type="text"
                value={reason}
                placeholder="Deny and tell it why…"
                aria-label="Reason for denying"
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitReason();
                  }
                }}
              />
              <button
                type="button"
                className="ma-reason-send"
                aria-label="Deny with this reason"
                disabled={!reason.trim()}
                onClick={submitReason}
              >
                <Icon name="send" size={18} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
