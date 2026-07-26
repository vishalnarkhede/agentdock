import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { fetchNgrokStatus, startNgrok, stopNgrok } from "../api";
import { isDemo } from "../demo";
import type { NgrokStatus } from "../api";

/**
 * Owns the share-link (ngrok tunnel) state.
 *
 * This is a provider rather than a plain hook because the desktop nav, the mobile menu
 * and the popover all render the same state — a hook per consumer would mean three
 * independent poll timers racing each other.
 */

export type ShareLinkPhase = "idle" | "starting" | "stopping" | "active" | "error";

interface ShareLinkValue {
  status: NgrokStatus;
  phase: ShareLinkPhase;
  /** Set when the server refused because nothing meaningful protects the dashboard. */
  gated: boolean;
  start: (opts?: { acknowledgeUnprotected?: boolean }) => Promise<void>;
  stop: () => Promise<void>;
  dismissError: () => void;
}

const IDLE: NgrokStatus = { running: false, url: null, protection: "none" };

const ShareLinkContext = createContext<ShareLinkValue | null>(null);

const ACTIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 30000;

export function ShareLinkProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<NgrokStatus>(IDLE);
  const [phase, setPhase] = useState<ShareLinkPhase>("idle");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const gated = phase === "error" && status.reason === "unprotected";

  const sync = useCallback(async () => {
    // Never let a poll overwrite an in-flight transition or a failure the user
    // hasn't acknowledged yet.
    if (phaseRef.current === "starting" || phaseRef.current === "stopping") return;
    if (phaseRef.current === "error") return;
    try {
      const next = await fetchNgrokStatus();
      setStatus(next);
      setPhase(next.running ? "active" : "idle");
    } catch {
      // A failed poll says nothing about the tunnel — leave the last known state.
    }
  }, []);

  useEffect(() => {
    if (isDemo()) return;
    void sync();
  }, [sync]);

  // Poll while idle too, at a slower cadence: a tunnel may have been started outside
  // the app, or by another browser tab.
  useEffect(() => {
    if (isDemo()) return;
    const interval = phase === "active" ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    const id = setInterval(() => void sync(), interval);
    return () => clearInterval(id);
  }, [phase, sync]);

  const start = useCallback(async (opts?: { acknowledgeUnprotected?: boolean }) => {
    setPhase("starting");
    try {
      const next = await startNgrok(opts);
      setStatus(next);
      setPhase(next.running ? "active" : "error");
    } catch (err: any) {
      setStatus({
        running: false,
        url: null,
        error: err?.message ?? "Couldn't start the share link.",
        reason: "unknown",
        protection: "none",
      });
      setPhase("error");
    }
  }, []);

  const stop = useCallback(async () => {
    setPhase("stopping");
    try {
      await stopNgrok();
    } catch {
      // Fall through to a status re-read either way.
    }
    setStatus((prev) => ({ ...prev, running: false, url: null, error: undefined, reason: undefined }));
    setPhase("idle");
  }, []);

  const dismissError = useCallback(() => {
    setStatus((prev) => ({ ...prev, error: undefined, reason: undefined, detail: undefined }));
    setPhase("idle");
  }, []);

  return (
    <ShareLinkContext.Provider value={{ status, phase, gated, start, stop, dismissError }}>
      {children}
    </ShareLinkContext.Provider>
  );
}

export function useShareLink(): ShareLinkValue {
  const ctx = useContext(ShareLinkContext);
  if (!ctx) throw new Error("useShareLink must be used inside a ShareLinkProvider");
  return ctx;
}
