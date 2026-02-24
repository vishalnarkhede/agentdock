import { useEffect, useRef } from "react";

// Strip ANSI escape codes so patterns match raw text
function stripAnsi(str: string): string {
  return str.replace(/\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07|[()][A-Z0-9]|.)/g, "");
}

/**
 * Detects when Claude finishes (waiting for input) and sends a browser notification.
 *
 * Detection: Claude Code's status bar shows "esc to interrupt" while working.
 * When that disappears, Claude is done. The transition triggers a notification
 * if the user is not looking at the page.
 */
export function useNotifications(
  sessionName: string,
  content: string | null,
  enabled: boolean = true,
) {
  const wasWorkingRef = useRef(false);
  const permissionRef = useRef<NotificationPermission>("default");

  // Request notification permission on mount
  useEffect(() => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      permissionRef.current = "granted";
    } else if (Notification.permission !== "denied") {
      Notification.requestPermission().then((perm) => {
        permissionRef.current = perm;
      });
    }
  }, []);

  useEffect(() => {
    if (!content || !enabled) return;

    const clean = stripAnsi(content);
    const isWorking = clean.includes("esc to interrupt");

    if (isWorking) {
      wasWorkingRef.current = true;
    } else if (wasWorkingRef.current && !isWorking) {
      // Transition: was working -> now idle
      wasWorkingRef.current = false;

      console.log("[notif] transition detected: working -> idle", {
        hidden: document.hidden,
        hasFocus: document.hasFocus(),
        permission: permissionRef.current,
        enabled,
      });

      // Notify if tab is hidden or window lost focus
      if ((document.hidden || !document.hasFocus()) && permissionRef.current === "granted") {
        console.log("[notif] sending notification!");
        const displayName = sessionName.replace(/^claude-/, "");
        new Notification(`${displayName} ready`, {
          body: "Claude is waiting for input",
          tag: `claude-${sessionName}`,
        });
      } else {
        console.log("[notif] skipped:", !document.hidden && document.hasFocus() ? "window is focused" : `permission=${permissionRef.current}`);
      }
    }
  }, [content, sessionName, enabled]);
}
