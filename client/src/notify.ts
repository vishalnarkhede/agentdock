/** A notification was clicked, and this is the session it was about. */
export const OPEN_SESSION_EVENT = "agentdock-open-session";

/**
 * A desktop notification that responds to being clicked.
 *
 * There is no button, because the Notifications API only offers `actions` to
 * notifications shown through a service worker — set on a plain `Notification`
 * they are dropped without a word. So the whole notification is the button.
 *
 * Every notification at least brings this window forward; one raised for a
 * session also opens it. Returns whether it was shown, so a caller can say why
 * nothing appeared.
 */
export function notify(
  title: string,
  body: string,
  options: { tag: string; sessionName?: string; onClick?: () => void },
): boolean {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;

  const notification = new Notification(title, { body, tag: options.tag });
  notification.onclick = () => {
    /* Before anything else: focusing is only permitted while the click is still
       the current user gesture. */
    window.focus();
    notification.close();
    if (options.sessionName) {
      window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: options.sessionName }));
    }
    options.onClick?.();
  };
  return true;
}

/**
 * Notify about a session, and open it when clicked.
 *
 * One tag per session, so an agent that changes state twice replaces its own
 * notification rather than stacking a second one behind it.
 */
export function notifySession(sessionName: string, title: string, body: string): void {
  notify(title, body, { tag: `agentdock-${sessionName}`, sessionName });
}
