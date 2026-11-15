/**
 * R3.1 — Per-gameweek / per-appearance performance score.
 *
 * Grain decision (required at the top of R3.1 per TODO_2627.md):
 *   R2.3 proved that for live 26/27 FPL payloads, `player_fixture_stat` (built
 *   from `explain`) omits conditionally scoring stats (clean sheets for mids/fwds,
 *   saves < 3, goals conceded < 2, defensive contribution below threshold) and
 *   never carries tackles, CBI, recoveries, xG, xA, xGC, threat, or creativity.
 *   Meanwhile `player_gameweek_stat` (FPL's `stats` block verbatim) is 100%
 *   complete for all 29 fields across both single and double gameweeks.
 *
 *   We therefore compute performance scores at **gameweek grain** from
 *   `player_gameweek_stat` (normalising double-gameweek volume by `max(1, minutes / 90)`
 *   when minutes > 90 so a 180-minute double gameweek isn't artificially scored as
 *   a 2x single-match outlier in the per-90 rate, while still rewarding the full
 *   per-appearance output).
 *
 * Cohort z-scoring:
 *   - Only active appearances (`minutes > 0`) participate in the positional
 *     cohort mean and standard deviation `(μ_pos, σ_pos)`. Players who sat on the
 *     bench (`minutes === 0`) do not dilute the on-pitch distribution and receive
 *     `zScore = 0` (their absence is captured in R3.4's availability multiplier `M_p`,
 *     not by pretending they played poorly on the pitch).
 *   - Within each position group (`GKP`, `DEF`, `MID`, `FWD`), active appearances
 *     have exact mean `0` and population standard deviation `1` (whenever `σ_pos > 0`).
 */

import type { PlayerPosition } from '@prisma/client';
import { POSITION_WEIGHTS, type PositionWeights } from './config';

export interface PerformanceStatInput {
  playerSeasonId: number;
  gameweekNumber: number;
  position: PlayerPosition;
  minutes: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  tackles: number;
  recoveries: number;
  clearancesBlocksInterceptions: number;
  defensiveContribution: number;
  expectedGoals: number | string;
  expectedAssists: number | string;
  expectedGoalsConceded: number | string;
  threat?: number | string;
  creativity?: number | string;
}

export interface RawPerformanceBreakdown {
  attack: number;
  defence: number;
  discipline: number;
  bonusComponent: number;
  rawScore: number;
}

export interface ScoredPerformance extends RawPerformanceBreakdown {
  playerSeasonId: number;
  gameweekNumber: number;
  position: PlayerPosition;
  minutes: number;
  /** Position-normalised z-score `S_i` (0 for 0-minute non-appearances). */
  zScore: number;
}

export interface CohortStats {
  count: number;
  mean: number;
  sd: number;
}

function toNum(v: number | string | undefined): number {
  if (v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the raw (pre-z-score) performance components for a single player-gameweek row.
 * Pure function of the stat line and position weights.
 */
export function computeRawPerformance(
  stat: PerformanceStatInput,
  weights: PositionWeights = POSITION_WEIGHTS[stat.position],
): RawPerformanceBreakdown {
  if (stat.minutes <= 0) {
    return { attack: 0, defence: 0, discipline: 0, bonusComponent: 0, rawScore: 0 };
  }

  const xG = toNum(stat.expectedGoals);
  const xA = toNum(stat.expectedAssists);
  const xGC = toNum(stat.expectedGoalsConceded);
  const threat100 = toNum(stat.threat) / 100;
  const creativity100 = toNum(stat.creativity) / 100;

  // If a player played a double gameweek (> 105 mins), scale per-appearance count
  // softly by sqrt(90 / minutes) or per-fixture equivalent so a 180-min week is
  // comparable to single-match weeks in the z-score distribution without erasing
  // strong double-GW output.
  const fixtureScale = stat.minutes > 105 ? 90 / stat.minutes : 1;

  const attack =
    (weights.goals * stat.goalsScored +
      weights.assists * stat.assists +
      weights.expectedGoals * xG +
      weights.expectedAssists * xA +
      weights.threatPer100 * threat100 +
      weights.creativityPer100 * creativity100) *
    fixtureScale;

  const defence =
    (weights.cleanSheets * stat.cleanSheets +
      weights.saves * stat.saves +
      weights.penaltiesSaved * stat.penaltiesSaved +
      weights.tackles * stat.tackles +
      weights.clearancesBlocksInterceptions * stat.clearancesBlocksInterceptions +
      weights.recoveries * stat.recoveries +
      weights.defensiveContribution * stat.defensiveContribution +
      weights.goalsConceded * stat.goalsConceded +
      weights.expectedGoalsConceded * xGC) *
    fixtureScale;

  const discipline =
    (weights.yellowCards * stat.yellowCards +
      weights.redCards * stat.redCards +
      weights.ownGoals * stat.ownGoals +
      weights.penaltiesMissed * stat.penaltiesMissed) *
    fixtureScale;

  const bonusComponent = weights.bonus * stat.bonus * fixtureScale;
  const rawScore = attack + defence + discipline + bonusComponent;

  return {
    attack,
    defence,
    discipline,
    bonusComponent,
    rawScore,
  };
}

/**
 * Compute position-normalised performance z-scores (`S_i`) across a cohort of
 * player-gameweek rows.
 *
 * Within each position (`GKP`, `DEF`, `MID`, `FWD`), active rows (`minutes > 0`)
 * are standardised to `mean = 0`, `sd = 1`.
 */
export function scorePerformanceCohort(
  rows: readonly PerformanceStatInput[],
  customWeights?: Record<PlayerPosition, PositionWeights>,
): {
  scores: ScoredPerformance[];
  cohorts: Record<PlayerPosition, CohortStats>;
} {
  const weightsByPos = customWeights ?? POSITION_WEIGHTS;
  const rawItems = rows.map((r) => ({
    row: r,
    raw: computeRawPerformance(r, weightsByPos[r.position]),
  }));

  const positions: PlayerPosition[] = ['GKP', 'DEF', 'MID', 'FWD'];
  const cohorts = {} as Record<PlayerPosition, CohortStats>;

  for (const pos of positions) {
    const active = rawItems.filter((item) => item.row.position === pos && item.row.minutes > 0);
    if (active.length === 0) {
      cohorts[pos] = { count: 0, mean: 0, sd: 0 };
      continue;
    }
    const mean = active.reduce((acc, item) => acc + item.raw.rawScore, 0) / active.length;
    const variance =
      active.reduce((acc, item) => {
        const d = item.raw.rawScore - mean;
        return acc + d * d;
      }, 0) / active.length;
    const sd = Math.sqrt(variance);
    cohorts[pos] = { count: active.length, mean, sd };
  }

  const scores: ScoredPerformance[] = rawItems.map(({ row, raw }) => {
    if (row.minutes <= 0) {
      return {
        playerSeasonId: row.playerSeasonId,
        gameweekNumber: row.gameweekNumber,
        position: row.position,
        minutes: row.minutes,
        ...raw,
        zScore: 0,
      };
    }
    const cohort = cohorts[row.position];
    const zScore = cohort.sd > 1e-9 ? (raw.rawScore - cohort.mean) / cohort.sd : 0;
    return {
      playerSeasonId: row.playerSeasonId,
      gameweekNumber: row.gameweekNumber,
      position: row.position,
      minutes: row.minutes,
      ...raw,
      zScore,
    };
  });

  return { scores, cohorts };
}
