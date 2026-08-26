import { useMemo } from "react";
import { qrMatrix, qrPath } from "../qr";

/**
 * A URL as a QR code, so there is no IP address to type on a phone.
 *
 * Deliberately not the only way through: the URL is always shown as text with a
 * copy button beside it, and this is the shortcut. Scanning is the only real
 * test of a QR code, so if a render is ever wrong the panel still works.
 *
 * Black on white whatever the theme: a scanner wants the contrast the spec
 * assumes, and a code tinted to match a dark pane is one some phones will not
 * read.
 */
export function QrCode({ url, size = 148 }: { url: string; size?: number }) {
  const { path, extent } = useMemo(() => qrPath(qrMatrix(url)), [url]);

  return (
    <svg
      className="qr"
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for ${url}`}
    >
      <rect width={extent} height={extent} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
