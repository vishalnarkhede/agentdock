import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { deleteNgrokBasicAuth } from "../api";
import { useShareLink } from "../hooks/useShareLink";
import type { NgrokErrorReason, NgrokStatus } from "../api";

/**
 * The share-link control: a status chip that opens a popover.
 *
 * The chip never starts or stops on a single click — it reports state, and the action
 * lives on a labelled button inside the popover. That's what makes the state legible
 * instead of leaving the user to guess whether a label is a state or an action.
 */

interface ChipCopy {
  label: string;
  dot: string;
  title: string;
}

function chipCopy(status: NgrokStatus, phase: string): ChipCopy {
  if (phase === "starting") {
    return { label: "Starting…", dot: "starting", title: "Starting your public link…" };
  }
  if (phase === "stopping") {
    return { label: "Stopping…", dot: "starting", title: "Stopping the public link…" };
  }
  if (phase === "error") {
    return { label: "Share failed", dot: "error", title: "Couldn't start — click for details" };
  }
  if (status.running) {
    const open = status.protection === "none" || status.protection === "weak-password";
    return open
      ? {
          label: "Sharing · open",
          dot: "open",
          title: "Live and weakly protected — anyone with the link has full access",
        }
      : { label: "Sharing · on", dot: "on", title: `Live at ${status.url ?? ""}` };
  }
  // Only the idle state names the object: "Share" alone reads as though it might
  // share the selected agent. Once sharing is live the object is established, so the
  // active states stay short.
  return { label: "Share dashboard", dot: "idle", title: "Share this dashboard with a public link" };
}

interface ErrorCopy {
  heading: string;
  hint?: string;
  command?: string;
  link?: { href: string; label: string };
}

const ERROR_COPY: Record<NgrokErrorReason, ErrorCopy> = {
  not_installed: {
    heading: "ngrok isn't installed",
    hint: "Install it, then try again:",
    command: "brew install ngrok",
    link: { href: "https://ngrok.com/download", label: "Other install options" },
  },
  not_authed: {
    heading: "ngrok needs an authtoken",
    hint: "Get a free token, then run:",
    command: "ngrok config add-authtoken <token>",
    link: {
      href: "https://dashboard.ngrok.com/get-started/your-authtoken",
      label: "Get your authtoken",
    },
  },
  basic_auth_unsupported: {
    heading: "Basic auth isn't available on your ngrok plan",
    hint: "Remove it and rely on your AgentDock password instead.",
  },
  agent_conflict: {
    heading: "Another ngrok agent is running",
    hint: "Stop the other tunnel, then try again.",
  },
  timeout: { heading: "Timed out waiting for the tunnel" },
  unprotected: { heading: "This puts your dashboard on the public internet" },
  unknown: { heading: "Couldn't start the share link" },
};

function openSecuritySettings() {
  // Reuse the existing settings flow rather than building a second one. Both listeners
  // are already registered (Header and SettingsModal), and SettingsModal registers its
  // tab listener before its `if (!open) return null`, so these can fire in one tick.
  window.dispatchEvent(new CustomEvent("agentdock-tutorial-open-settings"));
  window.dispatchEvent(new CustomEvent("agentdock-settings-tab", { detail: "security" }));
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      className="btn btn-sm share-copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
        } catch {
          // Clipboard can be blocked (insecure context) — the URL is selectable anyway.
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ProtectionLine({ protection }: { protection: NgrokStatus["protection"] }) {
  if (protection === "basic-auth") {
    return <p className="share-protection">Protected by ngrok basic auth.</p>;
  }
  if (protection === "password") {
    return <p className="share-protection">Protected by your AgentDock password.</p>;
  }
  return (
    <div className="settings-security-error share-protection-warn">
      <p>
        {protection === "none"
          ? "Unprotected — anyone with this link can run shell commands on this machine."
          : "Weak password — anyone with this link can run shell commands on this machine."}
      </p>
      <button className="btn btn-sm" onClick={openSecuritySettings}>
        Strengthen password…
      </button>
    </div>
  );
}

function PopoverBody({ onClose }: { onClose: () => void }) {
  const { status, phase, gated, start, stop, dismissError } = useShareLink();
  const [showDetail, setShowDetail] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (phase === "starting" || phase === "stopping" || retrying) {
    return (
      <>
        <h3 className="share-popover-title">{phase === "stopping" ? "Stopping…" : "Connecting…"}</h3>
        <p className="share-popover-body">
          {phase === "stopping"
            ? "Shutting down the tunnel."
            : "Starting ngrok and waiting for the tunnel."}
        </p>
      </>
    );
  }

  if (gated) {
    const copy = ERROR_COPY.unprotected;
    return (
      <>
        <h3 className="share-popover-title">{copy.heading}</h3>
        <p className="share-popover-body">{status.error}</p>
        <div className="share-popover-actions">
          <button className="btn btn-primary btn-sm" onClick={openSecuritySettings}>
            Strengthen password…
          </button>
          <button
            className="btn btn-danger-sm"
            onClick={() => void start({ acknowledgeUnprotected: true })}
          >
            Share anyway
          </button>
        </div>
      </>
    );
  }

  if (phase === "error") {
    const reason = status.reason ?? "unknown";
    const copy = ERROR_COPY[reason];
    return (
      <>
        <h3 className="share-popover-title">{copy.heading}</h3>
        <div className="settings-security-error">
          <p>{status.error}</p>
        </div>
        {copy.hint && <p className="share-popover-body">{copy.hint}</p>}
        {copy.command && <code className="settings-health-install share-install">{copy.command}</code>}
        {copy.link && (
          <a className="share-help-link" href={copy.link.href} target="_blank" rel="noopener noreferrer">
            {copy.link.label} ↗
          </a>
        )}
        <div className="share-popover-actions">
          <button className="btn btn-primary btn-sm" onClick={() => void start()}>
            Try again
          </button>
          {reason === "basic_auth_unsupported" && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                setRetrying(true);
                await deleteNgrokBasicAuth();
                setRetrying(false);
                void start();
              }}
            >
              Remove ngrok basic auth
            </button>
          )}
          <button className="btn btn-sm" onClick={dismissError}>
            Dismiss
          </button>
        </div>
        {status.detail && (
          <div className="share-detail">
            <button className="share-detail-toggle" onClick={() => setShowDetail((v) => !v)}>
              {showDetail ? "Hide ngrok output" : "Show ngrok output"}
            </button>
            {showDetail && <pre className="share-detail-output">{status.detail}</pre>}
          </div>
        )}
      </>
    );
  }

  if (status.running && status.url) {
    return (
      <>
        <h3 className="share-popover-title">
          <span className="share-dot share-dot-on" /> Live
        </h3>
        <div className="share-url-row">
          <a className="share-url" href={status.url} target="_blank" rel="noopener noreferrer">
            {status.url.replace("https://", "")}
          </a>
          <CopyButton url={status.url} />
        </div>
        <ProtectionLine protection={status.protection} />
        <div className="share-popover-actions">
          <button
            className="btn btn-danger-sm"
            onClick={async () => {
              await stop();
              onClose();
            }}
          >
            Stop sharing
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <h3 className="share-popover-title">Share this dashboard</h3>
      <p className="share-popover-body">
        Open a public HTTPS link to this dashboard so you can use it from your phone or another
        network. Powered by ngrok.
      </p>
      <div className="share-popover-actions">
        <button className="btn btn-primary btn-sm" onClick={() => void start()}>
          Create public link
        </button>
      </div>
    </>
  );
}

export function ShareLinkButton({ variant }: { variant: "desktop" | "mobile" }) {
  const { status, phase } = useShareLink();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  const copy = chipCopy(status, phase);

  const openPopover = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    // Right-align to the trigger, clamped into the viewport. The popover is portaled
    // and fixed because .header-mobile-menu is an absolute, overflow-bounded parent.
    const width = 320;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    setStyle({ top: r.bottom + 6, left });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.(".share-popover")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // Surface a failure the moment it happens, without the user having to re-open.
  useEffect(() => {
    if (phase === "error") setOpen(true);
  }, [phase]);

  return (
    <>
      <button
        ref={triggerRef}
        className={`share-chip share-chip-${variant} share-chip-${copy.dot}`}
        onClick={() => (open ? setOpen(false) : openPopover())}
        title={copy.title}
        aria-expanded={open}
        aria-live="polite"
      >
        <span className={`share-dot share-dot-${copy.dot}`} />
        {copy.label}
      </button>
      {open &&
        createPortal(
          <div className="share-popover" style={{ top: style.top, left: style.left }}>
            <PopoverBody onClose={() => setOpen(false)} />
            <div className="share-popover-footer">ngrok · localhost:{window.location.port || "5173"}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
