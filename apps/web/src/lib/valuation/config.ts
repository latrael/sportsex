/**
 * R3.8 & R3.7 — Valuation model parameters and position weights.
 *
 * Owner / Product Decision (R3.8):
 * "What a clean sheet is worth relative to a goal. Determines whether this is a
 * fantasy-football clone or its own thing. Decide deliberately; don't default to
 * FPL scoring."
 *
 * Decision & Rationale:
 *   In standard FPL, a GK/DEF clean sheet is worth 4 pts vs a forward's goal at
 *   4 pts (1.0x), while midfielders get 5 pts/goal and 1 pt/CS, and defensive
 *   process stats (tackles, clearances/blocks/interceptions, recoveries, xGC
 *   suppression) were historically ignored or reduced to a coarse threshold.
 *   That creates two failure modes in a stock market:
 *     1. Centre-backs and defensive midfielders ("6s" like Rodri, Rice, Caicedo)
 *        are chronically undervalued because their ball-winning volume doesn't
 *        show up in goals or clean sheets alone.
 *     2. Clean sheets are noisy team-level step functions (conceding in the 94th
 *        minute wipes out 90 minutes of elite defending).
 *
 *   Our market deliberately prices **two-way football contribution + underlying
 *   expected threat/prevention**:
 *     - A goalkeeper clean sheet is weighted at **0.85x a forward's goal**
 *       (and a defender's clean sheet at **0.75x**), with the remaining defensive
 *       value shifted onto **active defensive actions** (saves, penalty saves,
 *       tackles, CBI, recoveries, defensive contribution) and **xGC vs goals
 *       conceded suppression**.
 *     - Midfielders receive meaningful weight on ball recovery & tackling so elite
 *       holding midfielders compete with attacking wingers.
 *     - Every position group is z-scored within its own cohort (`GKP`, `DEF`,
 *       `MID`, `FWD`) and anchored to a unified `P_pos_base` so that an elite
 *       goalkeeper, elite centre-back, elite playmaker, and elite striker all
 *       reach the top tier of the market.
 */

import type { PlayerPosition } from '@prisma/client';

export interface PositionWeights {
  // Attack
  goals: number;
  assists: number;
  expectedGoals: number;
  expectedAssists: number;
  threatPer100: number;
  creativityPer100: number;

  // Defence
  cleanSheets: number;
  saves: number;
  penaltiesSaved: number;
  tackles: number;
  clearancesBlocksInterceptions: number;
  recoveries: number;
  defensiveContribution: number;
  goalsConceded: number;
  expectedGoalsConceded: number;

  // Discipline & bonus
  yellowCards: number;
  redCards: number;
  ownGoals: number;
  penaltiesMissed: number;
  bonus: number;
}

/**
 * R3.8 committed position weights.
 * Reference unit: 1.0 = a forward's goal (`FWD.goals = 1.0`).
 * Clean sheet relative to a goal:
 *   - GKP: 0.85 (supplemented by saves = 0.22/save and xGC/GC prevention)
 *   - DEF: 0.75 (supplemented by tackles = 0.14, CBI = 0.06, recoveries = 0.04)
 *   - MID: 0.25 (rewarding two-way box-to-box / holding mids without turning wingers into defenders)
 *   - FWD: 0.00 (forwards are judged on pressing/attacking output, not clean sheets)
 */
export const POSITION_WEIGHTS: Record<PlayerPosition, PositionWeights> = {
  GKP: {
    goals: 1.5,
    assists: 1.0,
    expectedGoals: 0.5,
    expectedAssists: 0.6,
    threatPer100: 0.0,
    creativityPer100: 0.1,

    cleanSheets: 0.85,
    saves: 0.22,
    penaltiesSaved: 1.2,
    tackles: 0.05,
    clearancesBlocksInterceptions: 0.04,
    recoveries: 0.03,
    defensiveContribution: 0.04,
    goalsConceded: -0.22,
    expectedGoalsConceded: -0.12,

    yellowCards: -0.35,
    redCards: -1.6,
    ownGoals: -0.9,
    penaltiesMissed: -0.8,
    bonus: 0.25,
  },
  DEF: {
    goals: 1.25,
    assists: 0.9,
    expectedGoals: 0.95,
    expectedAssists: 0.75,
    threatPer100: 0.25,
    creativityPer100: 0.3,

    cleanSheets: 0.75,
    saves: 0.0,
    penaltiesSaved: 0.0,
    tackles: 0.14,
    clearancesBlocksInterceptions: 0.06,
    recoveries: 0.04,
    defensiveContribution: 0.05,
    goalsConceded: -0.18,
    expectedGoalsConceded: -0.12,

    yellowCards: -0.35,
    redCards: -1.6,
    ownGoals: -0.9,
    penaltiesMissed: -0.8,
    bonus: 0.25,
  },
  MID: {
    goals: 1.05,
    assists: 0.8,
    expectedGoals: 0.9,
    expectedAssists: 0.7,
    threatPer100: 0.35,
    creativityPer100: 0.4,

    cleanSheets: 0.25,
    saves: 0.0,
    penaltiesSaved: 0.0,
    tackles: 0.1,
    clearancesBlocksInterceptions: 0.04,
    recoveries: 0.035,
    defensiveContribution: 0.035,
    goalsConceded: -0.04,
    expectedGoalsConceded: -0.03,

    yellowCards: -0.35,
    redCards: -1.6,
    ownGoals: -0.9,
    penaltiesMissed: -0.8,
    bonus: 0.25,
  },
  FWD: {
    goals: 1.0,
    assists: 0.75,
    expectedGoals: 0.9,
    expectedAssists: 0.65,
    threatPer100: 0.4,
    creativityPer100: 0.3,

    cleanSheets: 0.0,
    saves: 0.0,
    penaltiesSaved: 0.0,
    tackles: 0.05,
    clearancesBlocksInterceptions: 0.02,
    recoveries: 0.02,
    defensiveContribution: 0.02,
    goalsConceded: 0.0,
    expectedGoalsConceded: 0.0,

    yellowCards: -0.35,
    redCards: -1.6,
    ownGoals: -0.9,
    penaltiesMissed: -0.8,
    bonus: 0.25,
  },
};

/**
 * Calibrated Layer 1 hyperparameters (R3.7).
 *
 * - `POSITION_BASE_PRICE`: Base price `P_pos_base` for an average regular starter
 *   (`B = 0, F = 0, M = 1`) in each position group. Anchored around 180–210 coins
 *   so that:
 *     - Elite performers (`0.6·B + 0.4·F ≈ +1.5..+2.2`, `M ≈ 1.0`) reach ~600–1250 coins.
 *     - First-choice starters (`0.6·B + 0.4·F ≈ -0.2..+0.7`, `M ≈ 0.85..1.0`) sit at ~150–450 coins.
 *     - Squad rotation players (`M ≈ 0.35..0.65`) sit at ~45–120 coins.
 *     - Fringe / injured / unplayed (`M ≈ 0.12..0.25`) sit at ~10–35 coins.
 * - `LAMBDA`: Exponential sensitivity `λ` in `P_pos_base · exp(λ · (0.6·B + 0.4·F)) · M`.
 * - `FORM_HALF_LIFE_MATCHES`: Half-life `h = 4` matches/appearances in `w_i = 0.5^(i / h)`.
 * - `SHRINKAGE_K_90S`: Empirical Bayes prior strength `k = 6` full 90-minute equivalents.
 * - `BASELINE_WEIGHT` / `FORM_WEIGHT`: 0.6 / 0.4 blend of season baseline `B_p` and recent form `F_p`.
 * - `MIN_FAIR_VALUE` / `MAX_FAIR_VALUE`: Clamped to `[10, 1500]`.
 */
export const POSITION_BASE_PRICE: Record<PlayerPosition, number> = {
  GKP: 195,
  DEF: 200,
  MID: 210,
  FWD: 215,
};

export const VALUATION_PARAMS = {
  lambda: 0.85,
  baselineWeight: 0.6,
  formWeight: 0.4,
  formHalfLifeMatches: 4,
  shrinkageK90s: 6,
  minutesWindow: 6,
  minutesHalfLife: 3,
  unavailableFloor: 0.15,
  minPlayableMinutesFloor: 0.12,
  minFairValue: 10,
  maxFairValue: 1500,
} as const;
