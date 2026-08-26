/**
 * Tests for qr.ts.
 *
 * A QR code can only really be tested by scanning it, and there is no scanner
 * here — so these check the structure a scanner looks for first: the three
 * finder patterns, the timing lines that let it measure the grid, and a version
 * big enough for the text. A code that gets those wrong is unreadable; one that
 * gets them right is at least a QR code.
 */

import { describe, expect, it } from "bun:test";
import { qrMatrix, qrPath } from "./qr";

const URL_ = "http://192.168.178.67:5290";

/** The 7×7 finder: dark ring, light ring, 3×3 dark core. */
function isFinder(m: boolean[][], top: number, left: number): boolean {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const inner = r === 1 || r === 5 || c === 1 || c === 5;
      const want = ring ? true : inner ? false : true;
      if (m[top + r][left + c] !== want) return false;
    }
  }
  return true;
}

describe("qrMatrix", () => {
  it("is square, and a version 1–40 size", () => {
    const m = qrMatrix(URL_);
    expect(m.length).toBe(m[0].length);
    /* Sizes run 21, 25, 29 … 177 — always 4n + 17. */
    expect((m.length - 17) % 4).toBe(0);
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.length).toBeLessThanOrEqual(177);
  });

  it("has a finder pattern in each of the three corners", () => {
    const m = qrMatrix(URL_);
    const n = m.length;
    expect(isFinder(m, 0, 0)).toBe(true);
    expect(isFinder(m, 0, n - 7)).toBe(true);
    expect(isFinder(m, n - 7, 0)).toBe(true);
  });

  it("has no finder in the fourth corner, where the alignment pattern goes", () => {
    const m = qrMatrix(URL_);
    const n = m.length;
    expect(isFinder(m, n - 7, n - 7)).toBe(false);
  });

  it("has the timing patterns that let a scanner measure the grid", () => {
    const m = qrMatrix(URL_);
    /* Row 6 and column 6 alternate dark/light between the finders. */
    for (let c = 8; c < m.length - 8; c++) expect(m[6][c]).toBe(c % 2 === 0);
    for (let r = 8; r < m.length - 8; r++) expect(m[r][6]).toBe(r % 2 === 0);
  });

  it("grows with the text rather than truncating it", () => {
    const short = qrMatrix("http://10.0.0.1:80");
    const long = qrMatrix(`http://10.0.0.1:80/${"x".repeat(300)}`);
    expect(long.length).toBeGreaterThan(short.length);
  });

  it("encodes a hostname URL as readily as an IP one", () => {
    expect(qrMatrix("http://vishals-macbook-pro-3.local:5290").length).toBeGreaterThan(20);
  });

  it("is stable — the same text gives the same code", () => {
    expect(qrMatrix(URL_)).toEqual(qrMatrix(URL_));
  });
});

describe("qrPath", () => {
  it("draws one square per dark module and nothing else", () => {
    const m = qrMatrix(URL_);
    const dark = m.flat().filter(Boolean).length;
    const { path } = qrPath(m);
    expect(path.match(/h1v1h-1z/g)?.length).toBe(dark);
  });

  it("leaves the quiet zone on every side", () => {
    const m = qrMatrix(URL_);
    const { extent } = qrPath(m, 2);
    expect(extent).toBe(m.length + 4);
  });

  it("offsets the modules into the quiet zone, never to the edge", () => {
    const { path } = qrPath([[true]], 2);
    expect(path).toBe("M2 2h1v1h-1z");
  });

  it("draws nothing for an empty matrix", () => {
    expect(qrPath([]).path).toBe("");
  });
});
