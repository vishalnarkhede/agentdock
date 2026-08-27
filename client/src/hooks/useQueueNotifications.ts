import { useEffect, useRef } from "react";
import type { SessionInfo } from "../types";
import { queueBucket, NOTIFY_BUCKETS, type QueueBucket } from "../queue";
import { notifySession } from "../notify";

/**
 * Notifies on the transitions that actually cost you something: an agent
 * starts waiting on you, or finishes and becomes reviewable.
 *
 * Two things this fixes about the previous implementation:
 *
 *  1. It watched the terminal text for "esc to interrupt". Status comes from
 *     Claude Code's lifecycle hooks, which are the source of truth — scanning
 *     the pane guesses at what the hooks already state exactly.
 *  2. It lived in TerminalView, which is mounted only for the session you are
 *     looking at. So it could never tell you about the other fourteen, which
 *     is the only case where a notification is useful at all.
 */
export interface NotifyPrefs {
  enabled: boolean;
  blocked: boolean;
  review: boolean;
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
}

/**
 * Quiet hours wrap midnight: 21 → 8 means "from 21:00 until 08:00", which is
 * two ranges on a clock face, not one. Exported for testing.
 */
export function isQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function useQueueNotifications(
  sessions: SessionInfo[],
  activeSession: string | null,
  prefs: NotifyPrefs,
) {
  const prev = useRef<Map<string, QueueBucket>>(new Map());
  const primed = useRef(false);
  const permission = useRef<NotificationPermission>("default");

  useEffect(() => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") permission.current = "granted";
    else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((p) => {
        permission.current = p;
      });
    }
  }, []);

  useEffect(() => {
    if (!prefs.enabled || sessions.length === 0) return;

    const next = new Map<string, QueueBucket>();
    for (const s of sessions) next.set(s.name, queueBucket(s));

    // First pass seeds the baseline. Without this you would get one
    // notification per session the moment the dashboard loads.
    if (!primed.current) {
      prev.current = next;
      primed.current = true;
      return;
    }

    // Quiet hours suppress the interruption, not the queue: the work still
    // shows up, it just does not buzz. Baseline is still advanced below, so
    // you are not ambushed by a backlog of alerts at 08:00.
    const quiet =
      prefs.quietEnabled &&
      isQuietHour(new Date().getHours(), prefs.quietStart, prefs.quietEnd);

    for (const s of sessions) {
      const to = next.get(s.name)!;
      const from = prev.current.get(s.name);
      if (from === to) continue;
      if (!NOTIFY_BUCKETS.includes(to)) continue;
      if (to === "blocked" && !prefs.blocked) continue;
      if (to === "review" && !prefs.review) continue;
      if (quiet) continue;
      // A brand-new session that starts life reviewable is not news.
      if (from === undefined) continue;

      // Worth interrupting for if you cannot already see it.
      const looking = s.name === activeSession && !document.hidden && document.hasFocus();
      if (looking || permission.current !== "granted") continue;

      const title =
        to === "blocked"
          ? `${s.displayName} is waiting on you`
          : `${s.displayName} is ready to review`;
      const body =
        s.statusLine?.message ||
        (to === "blocked" ? "It cannot continue without an answer." : "It finished its turn.");

      notifySession(s.name, title, body);
    }

    prev.current = next;
  }, [
    sessions,
    activeSession,
    prefs.enabled,
    prefs.blocked,
    prefs.review,
    prefs.quietEnabled,
    prefs.quietStart,
    prefs.quietEnd,
  ]);
}
