/**
 * Fuzzy path scoring, fzf-style. No dependencies.
 *
 * Two stages, because the index holds tens of thousands of paths and only a
 * handful survive: a linear subsequence test rejects most candidates, then a
 * Smith-Waterman-ish DP finds the best alignment for the rest. Greedy
 * left-to-right matching is not enough — for "fx" against "src/fx/FileX.ts"
 * the first `f` a greedy scan finds is the wrong one.
 */

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTEND = -1;

const BONUS_BOUNDARY = 8;
const BONUS_SEGMENT = 10;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 8;
const BONUS_BASENAME = 6;
const BONUS_FIRST_CHAR = 6;

export interface FuzzyMatch {
  score: number;
  positions: number[];
}

const SEP = 0x2f; // '/'

function isWordBreak(code: number): boolean {
  return code === 0x5f || code === 0x2d || code === 0x2e || code === 0x20; // _ - . space
}

function isUpper(code: number): boolean {
  return code >= 0x41 && code <= 0x5a;
}

function isLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

function isAlnum(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

/**
 * How much this position looks like the start of something a human would type.
 */
function positionBonus(target: string, j: number, basenameStart: number): number {
  let bonus = 0;
  if (j === 0) {
    bonus = BONUS_BOUNDARY + BONUS_FIRST_CHAR;
  } else {
    const prev = target.charCodeAt(j - 1);
    const cur = target.charCodeAt(j);
    if (prev === SEP) bonus = BONUS_SEGMENT;
    else if (isWordBreak(prev)) bonus = BONUS_BOUNDARY;
    else if (isLower(prev) && isUpper(cur)) bonus = BONUS_CAMEL;
    else if (!isAlnum(prev)) bonus = BONUS_BOUNDARY;
  }
  if (j >= basenameStart) bonus += BONUS_BASENAME;
  return bonus;
}

/** Linear reject: is `query` a subsequence of `target`? Both must be lowercase. */
export function isSubsequence(queryLower: string, targetLower: string): boolean {
  const m = queryLower.length;
  if (m === 0) return true;
  const n = targetLower.length;
  if (m > n) return false;
  let qi = 0;
  for (let ti = 0; ti < n; ti++) {
    if (targetLower.charCodeAt(ti) === queryLower.charCodeAt(qi)) {
      if (++qi === m) return true;
    }
  }
  return false;
}

/**
 * Score `query` against `target`. Returns null when the query is not a
 * subsequence of the target. `positions` are indices into `target`.
 *
 * `targetLower` may be supplied by callers that keep a pre-lowercased index,
 * which is the difference between one toLowerCase per candidate per keystroke
 * and none.
 */
export function score(
  query: string,
  target: string,
  targetLower?: string,
): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = targetLower ?? target.toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  if (!isSubsequence(q, t)) return null;

  const m = q.length;
  const n = t.length;
  const sep = target.lastIndexOf("/");
  const basenameStart = sep === -1 ? 0 : sep + 1;

  const NEG = -1e9;
  // M[i][j]: best score for query[0..i] with query[i] matched at target[j].
  const M = new Float64Array(m * n).fill(NEG);
  // Where the previous query char matched, so the alignment can be recovered.
  const back = new Int32Array(m * n).fill(-1);

  for (let i = 0; i < m; i++) {
    const qc = q.charCodeAt(i);
    const prevRow = (i - 1) * n;
    const row = i * n;

    // Best M[i-1][k] for k <= j-2, carrying an accumulating gap penalty.
    let bestGap = NEG;
    let bestGapIdx = -1;

    for (let j = 0; j < n; j++) {
      if (t.charCodeAt(j) === qc) {
        if (i === 0) {
          M[j] = SCORE_MATCH + positionBonus(target, j, basenameStart) + Math.max(0, 12 - j);
          back[j] = -1;
        } else {
          const bonus = positionBonus(target, j, basenameStart);
          const consec =
            j > 0 && M[prevRow + j - 1] > NEG
              ? M[prevRow + j - 1] + SCORE_MATCH + bonus + BONUS_CONSECUTIVE
              : NEG;
          const gapped = bestGap > NEG ? bestGap + SCORE_MATCH + bonus : NEG;

          if (consec >= gapped && consec > NEG) {
            M[row + j] = consec;
            back[row + j] = j - 1;
          } else if (gapped > NEG) {
            M[row + j] = gapped;
            back[row + j] = bestGapIdx;
          }
        }
      }

      if (i > 0 && j > 0) {
        const opened = M[prevRow + j - 1] > NEG ? M[prevRow + j - 1] + SCORE_GAP_START : NEG;
        const extended = bestGap > NEG ? bestGap + SCORE_GAP_EXTEND : NEG;
        if (opened >= extended) {
          if (opened > NEG) {
            bestGap = opened;
            bestGapIdx = j - 1;
          }
        } else {
          bestGap = extended;
        }
      }
    }
  }

  let best = NEG;
  let bestJ = -1;
  for (let j = 0; j < n; j++) {
    const v = M[(m - 1) * n + j];
    if (v > best) {
      best = v;
      bestJ = j;
    }
  }
  if (bestJ === -1) return null;

  const positions: number[] = new Array(m);
  let j = bestJ;
  for (let i = m - 1; i >= 0; i--) {
    positions[i] = j;
    j = back[i * n + j];
    if (j === -1 && i > 0) break;
  }

  // Shorter targets win ties: two paths that match equally well are not equally
  // good answers.
  let final = best - n * 0.05;

  const base = target.slice(basenameStart).toLowerCase();
  if (base === q) final += 90;
  else if (base.startsWith(q)) final += 45;
  else if (base.includes(q)) final += 20;
  else if (t.includes(q)) final += 10;

  return { score: final, positions };
}

export interface Scored<T> {
  item: T;
  score: number;
  positions: number[];
}

/**
 * Score every candidate and return the best `limit`, highest first.
 */
export function rank<T>(
  query: string,
  items: T[],
  text: (item: T) => string,
  lower: (item: T) => string,
  limit: number,
): Scored<T>[] {
  const q = query.toLowerCase();
  const out: Scored<T>[] = [];
  if (q.length === 0) {
    for (let i = 0; i < items.length && out.length < limit; i++) {
      out.push({ item: items[i], score: 0, positions: [] });
    }
    return out;
  }
  for (const item of items) {
    const tl = lower(item);
    if (!isSubsequence(q, tl)) continue;
    const r = score(query, text(item), tl);
    if (r) out.push({ item, score: r.score, positions: r.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
