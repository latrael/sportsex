/**
 * R3.2 — Form (`F_p`): EWMA over recent appearances, half-life ≈ 4 matches.
 *
 * Formula (REBUILD_PLAN §"The algorithm" b):
 *   F_p = Σ w_i · S_i / Σ w_i,   w_i = 0.5^(matches_ago / halfLife)
 *
 * where `matches_ago = 0` is the player's most recent appearance, `1` is the one
 * before that, etc. If the player has no active appearances yet, `F_p = 0`.
 */

import { VALUATION_PARAMS } from './config';

export interface FormObservation {
  /** Chronological index (e.g. gameweekNumber or fixture order). */
  order: number;
  /** Position-normalised performance z-score `S_i`. */
  score: number;
  /** Optional minutes; when provided, only observations with minutes > 0 count as played appearances. */
  minutes?: number;
}

/**
 * Compute EWMA form `F_p` over a sequence of scores ordered chronologically
 * (oldest to newest, or arbitrary order sorted by `.order`).
 *
 * If an array of plain numbers is passed, index `0` is oldest and `length - 1`
 * is most recent (`matches_ago = 0`).
 */
export function computeFormEwma(
  observations: readonly (number | FormObservation)[],
  halfLifeMatches: number = VALUATION_PARAMS.formHalfLifeMatches,
): number {
  if (halfLifeMatches <= 0) {
    throw new RangeError(`halfLifeMatches must be > 0, got ${halfLifeMatches}`);
  }
  if (observations.length === 0) return 0;

  // Normalise to played observations ordered oldest -> newest
  const played: number[] = [];
  if (typeof observations[0] === 'number') {
    for (const s of observations as readonly number[]) {
      played.push(s);
    }
  } else {
    const sorted = [...(observations as readonly FormObservation[])]
      .filter((o) => o.minutes === undefined || o.minutes > 0)
      .sort((a, b) => a.order - b.order);
    for (const o of sorted) {
      played.push(o.score);
    }
  }

  if (played.length === 0) return 0;

  let weightedSum = 0;
  let weightTotal = 0;
  const n = played.length;

  for (let idx = 0; idx < n; idx++) {
    const matchesAgo = n - 1 - idx; // 0 for the newest appearance
    const w = Math.pow(0.5, matchesAgo / halfLifeMatches);
    weightedSum += w * played[idx];
    weightTotal += w;
  }

  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}
