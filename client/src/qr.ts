/**
 * A URL as a grid of modules, and that grid as one SVG path.
 *
 * Split out from the component so the encoding can be checked without a
 * renderer. The encoder is qrcode-generator, the reference JavaScript
 * implementation of JIS X 0510 — the parts worth testing here are that we drive
 * it correctly and that what comes back has the structure a scanner looks for.
 */

import qrcode from "qrcode-generator";

/**
 * Dark modules of the smallest QR code that fits this text.
 *
 * Type 0 auto-sizes. Error correction M is the usual choice: around a quarter of
 * the code can be obscured and it still reads, without the extra size H costs.
 */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let row = 0; row < count; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < count; col++) line.push(qr.isDark(row, col));
    rows.push(line);
  }
  return rows;
}

/**
 * The matrix as a single path, plus the viewBox extent that contains it.
 *
 * One path rather than a rect per module: a URL of any length runs to several
 * hundred dark modules, and that many elements is a slow thing to put in a
 * settings pane. The margin is the spec's quiet zone rather than decoration — a
 * code butted up against surrounding content is one many scanners never see.
 */
export function qrPath(matrix: boolean[][], margin = 2): { path: string; extent: number } {
  const parts: string[] = [];
  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix[row].length; col++) {
      if (matrix[row][col]) parts.push(`M${col + margin} ${row + margin}h1v1h-1z`);
    }
  }
  return { path: parts.join(""), extent: matrix.length + margin * 2 };
}
