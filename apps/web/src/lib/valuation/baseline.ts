/**
 * R3.3 — Baseline with shrinkage (`B_p`):
 *
 * Formula (REBUILD_PLAN §"The algorithm" c):
 *   B_p = (n_90s · rate_p + k · cohort_prior_pos) / (n_90s + k),   k ≈ 6
 *
 * Solves cold-start continuously without special-case branches:
 *   - At `minutes = 0` (`n_90s = 0`), `B_p = cohort_prior_pos`.
 *   - At `minutes = 90` (`n_90s = 1`, `k = 6`), `B_p = (1 · rate_p + 6 · prior) / 7`,
 *     which pulls 6/7ths of the way to the positional cohort prior (within 10% of the
 *     positional median for typical first-appearance rates).
 *   - As `n_90s` grows, `B_p` converges monotonically toward `rate_p`.
 */

import type { PlayerPosition } from '@prisma/client';
import { VALUATION_PARAMS } from './config';

export interface BaselineInput {
  /** Total minutes played season-to-date. */
  minutes: number;
  /** Player's own per-90 performance rate (or mean z-score per 90). */
  ownRatePer90: number;
  /** Positional cohort prior (e.g. positional median rate, or 0 in z-score space). */
  cohortPrior: number;
  /** Shrinkage strength `k` in 90-minute equivalents (default 6). */
  k90s?: number;
}

/**
 * Compute empirical-Bayes shrunk baseline `B_p`.
 * Pure function; monotone in `minutes` (`n_90s = minutes / 90`) from `cohortPrior`
 * toward `ownRatePer90`.
 */
export function computeBaselineShrinkage(input: BaselineInput): number {
  const k = input.k90s ?? VALUATION_PARAMS.shrinkageK90s;
  if (k <= 0) {
    throw new RangeError(`k90s must be > 0, got ${k}`);
  }
  const n90s = Math.max(0, input.minutes) / 90;
  if (n90s === 0) return input.cohortPrior;
  return (n90s * input.ownRatePer90 + k * input.cohortPrior) / (n90s + k);
}

/**
 * Compute positional median (cohort prior) for each position from a list of
 * active players' per-90 rates.
 */
export function computeCohortMedianPriors(
  players: readonly { position: PlayerPosition; minutes: number; ownRatePer90: number }[],
): Record<PlayerPosition, number> {
  const positions: PlayerPosition[] = ['GKP', 'DEF', 'MID', 'FWD'];
  const result = { GKP: 0, DEF: 0, MID: 0, FWD: 0 } as Record<PlayerPosition, number>;

  for (const pos of positions) {
    const vals = players
      .filter((p) => p.position === pos && p.minutes >= 90)
      .map((p) => p.ownRatePer90)
      .sort((a, b) => a - b);
    if (vals.length === 0) {
      result[pos] = 0;
      continue;
    }
    const mid = Math.floor(vals.length / 2);
    result[pos] = vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }

  return result;
}
