/**
 * R3.5 — Compose Layer 1 Fair Value `V(p, t)`:
 *
 * Formula (REBUILD_PLAN §"The algorithm" e):
 *   V_p = clamp( P_pos_base · exp( λ · (0.6·B_p + 0.4·F_p) ) · M_p , 10 , 1500 )
 *
 * Invariant 6:
 *   Pure function of stats — same inputs, same output, no clock, no randomness.
 *
 * Also provides `clubFairValue()` for club assets (REBUILD_PLAN §"Layer 2"):
 *   Minutes-weighted squad fair value + points-per-game form + FPL strength rating.
 */

import type { Prisma, PlayerPosition } from '@prisma/client';
import { toPriceDecimal, toAuditDecimal, toMultiplierDecimal } from '@/lib/money';
import { POSITION_BASE_PRICE, VALUATION_PARAMS } from './config';

export interface FairValueCompositionInput {
  position: PlayerPosition;
  /** Baseline `B_p` (shrunk per-90 z-score rate). */
  baseline: number;
  /** Recent form `F_p` (EWMA z-score). */
  form: number;
  /** Availability multiplier `M_p` in `[0, 1]`. */
  availabilityMultiplier: number;
  /** Optional custom `λ` override. */
  lambda?: number;
  /** Optional custom `P_pos_base` override. */
  positionBase?: number;
}

export interface FairValueCompositionResult {
  /** Clamped fair value `V_p` in `[10, 1500]`, rounded to 4 decimal places. */
  value: number;
  /** Unclamped raw fair value before `[10, 1500]` clamp. */
  unclampedValue: number;
  baseline: number;
  form: number;
  availabilityMult: number;
  positionBase: number;
  /** Ready-to-persist `Prisma.Decimal` fields matching `FairValue` schema columns. */
  decimals: {
    value: Prisma.Decimal;
    baseline: Prisma.Decimal;
    form: Prisma.Decimal;
    availabilityMult: Prisma.Decimal;
    positionBase: Prisma.Decimal;
  };
}

/**
 * Pure, deterministic Layer 1 `fairValue()` composition (Invariant 6).
 */
export function fairValue(input: FairValueCompositionInput): FairValueCompositionResult {
  const posBase = input.positionBase ?? POSITION_BASE_PRICE[input.position];
  const lambda = input.lambda ?? VALUATION_PARAMS.lambda;
  const wB = VALUATION_PARAMS.baselineWeight;
  const wF = VALUATION_PARAMS.formWeight;

  const composite = wB * input.baseline + wF * input.form;
  const unclampedValue = posBase * Math.exp(lambda * composite) * input.availabilityMultiplier;
  const clamped = Math.max(
    VALUATION_PARAMS.minFairValue,
    Math.min(VALUATION_PARAMS.maxFairValue, unclampedValue),
  );
  const value = Number(clamped.toFixed(4));

  return {
    value,
    unclampedValue,
    baseline: input.baseline,
    form: input.form,
    availabilityMult: input.availabilityMultiplier,
    positionBase: posBase,
    decimals: {
      value: toPriceDecimal(clamped),
      baseline: toAuditDecimal(input.baseline),
      form: toAuditDecimal(input.form),
      availabilityMult: toMultiplierDecimal(input.availabilityMultiplier),
      positionBase: toPriceDecimal(posBase),
    },
  };
}

export interface ClubFairValueInput {
  /** Roster players with their current fair value `V_p` and season/recent minutes. */
  squad: readonly { fairValue: number; minutes: number }[];
  /** Points per game over last 6 matches (0..3). */
  recentPointsPerGame: number;
  /** FPL `strengthOverallHome` (typically ~1000..1350), nullable in preseason. */
  strengthOverallHome?: number | null;
  /** FPL `strengthOverallAway` (typically ~1000..1350), nullable in preseason. */
  strengthOverallAway?: number | null;
}

/**
 * Pure club fair value (REBUILD_PLAN §"Layer 2"):
 *   Minutes-weighted squad value + points-per-game form + FPL `strength_overall_home/away`.
 */
export function clubFairValue(input: ClubFairValueInput): {
  value: number;
  decimalValue: Prisma.Decimal;
} {
  let squadWeighted = 150;
  const totalMinutes = input.squad.reduce((acc, p) => acc + Math.max(0, p.minutes), 0);
  if (totalMinutes > 0) {
    squadWeighted =
      input.squad.reduce((acc, p) => acc + p.fairValue * Math.max(0, p.minutes), 0) / totalMinutes;
  } else if (input.squad.length > 0) {
    squadWeighted = input.squad.reduce((acc, p) => acc + p.fairValue, 0) / input.squad.length;
  }

  // PPG in [0, 3], centred at 1.38 (EPL average PPG): +/- ~15% swing
  const ppgFactor = 1 + 0.1 * (Math.max(0, Math.min(3, input.recentPointsPerGame)) - 1.38);

  // Strength rating centred around 1150 (EPL mean)
  const sh = input.strengthOverallHome ?? 1150;
  const sa = input.strengthOverallAway ?? 1150;
  const meanStrength = (sh + sa) / 2;
  const strengthBonus = Math.max(-40, Math.min(60, (meanStrength - 1150) * 0.2));

  const raw = squadWeighted * ppgFactor + strengthBonus;
  const clamped = Math.max(
    VALUATION_PARAMS.minFairValue,
    Math.min(VALUATION_PARAMS.maxFairValue, raw),
  );
  return {
    value: Number(clamped.toFixed(4)),
    decimalValue: toPriceDecimal(clamped),
  };
}
