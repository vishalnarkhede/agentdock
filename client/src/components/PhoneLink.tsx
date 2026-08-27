import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fetchPhoneLink, type PhoneLink } from "../api";
import { copyText } from "../clipboard";
import { Icon } from "./Icon";
import { QrCode } from "./QrCode";
import "../styles/settings-panes.css";

/**
 * The address to open AgentDock on your phone.
 *
 * Before this, the only place that address existed was vite's startup output in
 * a terminal — fine while you can see the terminal, useless from a phone, and
 * gone entirely in a wrapper that has no terminal at all.
 *
 * It is read fresh every time this mounts rather than remembered: a DHCP lease
 * hands out a different address on a different day, and a remembered one sends
 * you to a machine that is no longer at it.
 *
 * `title` is dropped when something else already names the panel — the modal
 * below puts it in its own header, and saying it twice reads as a mistake.
 */
export function PhoneLinkPanel({ title = "Open on your phone" }: { title?: string | null }) {
  const [link, setLink] = useState<PhoneLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(0);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchPhoneLink()
      .then((l) => {
        setLink(l);
        setChosen(0);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const port = link?.ports.find((p) => p.scheme === "http") ?? null;
  const address = link?.addresses[chosen] ?? null;
  /* Composed here rather than server-side so switching address is instant and
     needs no round trip — the port is the same whichever host you dial. */
  const url = address && port ? `http://${address.host}:${port.port}` : link?.url ?? null;

  const copy = async () => {
    if (!url) return;
    setCopied((await copyText(url)) ? "ok" : "fail");
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <div className="set-section">
      <div className="set-section-head">
        {title && <span className="set-section-title">{title}</span>}
        <button className="set-refresh" onClick={load} disabled={loading} title="Read the network again">
          <Icon name="refresh" size={12} />
          {loading ? "reading…" : "refresh"}
        </button>
      </div>

      {error && <div className="settings-security-error">{error}</div>}

      {url && (
        <div className="set-group">
          <div className="set-group-row set-group-row-top set-phone">
            <QrCode url={url} />
            <div className="set-copy">
              <span className="set-phone-url">{url}</span>
              {address && (
                <span className="set-copy-hint">
                  {address.note}
                  {address.kind !== "mdns" && <span className="set-phone-iface"> · {address.iface}</span>}
                </span>
              )}
              <div className="set-phone-actions">
                <button className="btn btn-primary" onClick={copy}>
                  <Icon name="copy" size={12} />
                  {copied === "ok" ? "copied" : copied === "fail" ? "copy failed" : "copy link"}
                </button>
                <a className="set-phone-open" href={url} target="_blank" rel="noreferrer">
                  open here
                  <Icon name="ext" size={11} />
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {link && !url && (
        <>
          <div className="set-note">
            <Icon name="alert" size={13} />
            <span>{link.problem ?? "No address to offer."}</span>
          </div>
          {link.problem?.includes("vite.mobile.config.ts") && (
            <code className="set-cmd">cd client &amp;&amp; npx vite --config vite.mobile.config.ts</code>
          )}
        </>
      )}

      {/* More than one route in is the normal case — Wi-Fi and Ethernet, or a
          VPN — and which of them a phone can reach is something only you know. */}
      {link && link.addresses.length > 1 && (
        <div className="set-group">
          {link.addresses.map((a, i) => (
            <button
              key={a.host}
              className={`set-group-row set-phone-alt${i === chosen ? " set-phone-alt-on" : ""}`}
              onClick={() => setChosen(i)}
              disabled={!port}
            >
              <span className={`set-dot ${i === chosen ? "set-dot-on" : ""}`} />
              <span className="set-copy">
                <span className="set-mono">{a.host}</span>
                <span className="set-copy-hint">{a.note}</span>
              </span>
              <span className="set-tag">{a.kind === "mdns" ? "name" : a.iface}</span>
            </button>
          ))}
        </div>
      )}

      <div className="set-note">
        <Icon name="globe" size={13} />
        <span>
          These only work on the same network. For anywhere else, start the ngrok tunnel from the
          launch menu in the header — and set a password in Settings › Access first, since that
          address is public.
        </span>
      </div>
    </div>
  );
}

/**
 * The same panel, one click from the header.
 *
 * It was reachable only through Settings › Access, which is three clicks and a
 * scroll past the password field — long enough that reading the IP out of a
 * terminal stayed the faster option, which is the habit this was meant to end.
 *
 * Mounted only while open, so each opening re-reads the network rather than
 * showing the address the laptop had the last time it was asked.
 */
export function PhoneLinkModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal phone-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Open on your phone</span>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="phone-modal-body">
          <PhoneLinkPanel title={null} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
