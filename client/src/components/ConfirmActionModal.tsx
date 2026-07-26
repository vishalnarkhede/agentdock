import { useEffect, useState } from "react";

export interface ConfirmAction {
  title: string;
  message: string;
  details?: string[];
  confirmLabel: string;
  busyLabel?: string;
  tone?: "danger" | "default";
  onConfirm: () => Promise<void> | void;
}

export function ConfirmActionModal({
  action,
  onClose,
}: {
  action: ConfirmAction;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, onClose]);

  const close = () => {
    if (!busy) onClose();
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action.onConfirm();
      onClose();
    } catch (err: any) {
      setError(err?.message || "Action failed");
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={close}>
      <div
        className="settings-modal confirm-action-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-action-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-action-body">
          <div className={`confirm-action-icon confirm-action-icon-${action.tone || "default"}`} aria-hidden="true">
            !
          </div>
          <div className="confirm-action-copy">
            <h2 id="confirm-action-title" className="confirm-action-title">{action.title}</h2>
            <p className="confirm-action-message">{action.message}</p>
            {action.details && action.details.length > 0 && (
              <ul className="confirm-action-details">
                {action.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            )}
            {error && <p className="form-error confirm-action-error">{error}</p>}
          </div>
        </div>
        <div className="confirm-action-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${action.tone === "danger" ? "btn-danger" : "btn-primary"}`}
            onClick={confirm}
            disabled={busy}
          >
            {busy ? (action.busyLabel || "Working...") : action.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
