/**
 * Pure gameweek & season valuation planner + DB sync (R3.1–R3.6).
 *
 * Given a season's players (`player_season`), gameweek stats (`player_gameweek_stat`),
 * and fixtures up to a target `upToGameweek`, computes every player's:
 *   - Performance z-score `S_i` per appearance (R3.1)
 *   - EWMA form `F_p` over recent appearances (R3.2)
 *   - Shrinkage baseline `B_p` from season per-90 z-score rate (R3.3)
 *   - Availability multiplier `M_p` from recent team-fixture minutes share + status (R3.4)
 *   - Fair value `V_p` (R3.5)
 */

import type { PlayerPosition } from '@prisma/client';
import { scorePerformanceCohort, type PerformanceStatInput } from './performance';
import { computeFormEwma } from './form';
import { computeBaselineShrinkage, computeCohortMedianPriors } from './baseline';
import { computeAvailabilityMultiplier, type RecentFixturePresence } from './availability';
import { fairValue, type FairValueCompositionResult } from './fairValue';

export interface PlayerValuationMetadata {
  playerSeasonId: number;
  fplId: number;
  webName: string;
  firstName: string;
  secondName: string;
  clubSeasonId: number;
  clubShortName: string;
  position: PlayerPosition;
  status: string;
  chanceOfPlayingNextRound: number | null;
  nowCost: number;
}

export interface EvaluatedPlayerValuation extends FairValueCompositionResult {
  playerSeasonId: number;
  fplId: number;
  webName: string;
  fullName: string;
  clubSeasonId: number;
  clubShortName: string;
  position: PlayerPosition;
  minutes: number;
  starts: number;
  appearances: number;
  ownRatePer90: number;
  expectedMinutesShare: number;
  availabilityFactor: number;
}

export interface EvaluateGameweekInput {
  players: readonly PlayerValuationMetadata[];
  /** All gameweek stat rows with `gameweekNumber <= targetGameweek`. */
  gameweekStatsUpToTarget: readonly (PerformanceStatInput & { starts: number })[];
  /** Target gameweek number (1..38). */
  targetGameweek: number;
  /**
   * Optional override for player status at historical backtest points.
   * In a historical replay of 25/26, `player_season.status` is the end-of-season
   * snapshot; during backtesting (`useSnapshotStatus = false`), availability at GW `t`
   * is driven by the observed minutes window unless `useSnapshotStatus = true`.
   */
  useSnapshotStatus?: boolean;
}

/**
 * Pure function that evaluates the entire league's fair values at `targetGameweek`
 * using all gameweek stats `1..targetGameweek`.
 */
export function evaluateLeagueAtGameweek(
  input: EvaluateGameweekInput,
): EvaluatedPlayerValuation[] {
  const { players, gameweekStatsUpToTarget, targetGameweek, useSnapshotStatus = true } = input;

  // 1. Filter rows up to targetGameweek and score the cohort (R3.1)
  const relevantStats = gameweekStatsUpToTarget.filter((s) => s.gameweekNumber <= targetGameweek);
  const { scores } = scorePerformanceCohort(relevantStats);

  // Group scored rows by playerSeasonId
  const scoresByPlayer = new Map<
    number,
    { gameweekNumber: number; minutes: number; starts: number; zScore: number }[]
  >();
  const startsLookup = new Map<string, number>();
  for (const s of relevantStats) {
    startsLookup.set(`${s.playerSeasonId}:${s.gameweekNumber}`, s.starts);
  }

  for (const sc of scores) {
    let list = scoresByPlayer.get(sc.playerSeasonId);
    if (!list) {
      list = [];
      scoresByPlayer.set(sc.playerSeasonId, list);
    }
    list.push({
      gameweekNumber: sc.gameweekNumber,
      minutes: sc.minutes,
      starts: startsLookup.get(`${sc.playerSeasonId}:${sc.gameweekNumber}`) ?? 0,
      zScore: sc.zScore,
    });
  }

  // Sort each player's history chronologically by gameweekNumber
  for (const list of scoresByPlayer.values()) {
    list.sort((a, b) => a.gameweekNumber - b.gameweekNumber);
  }

  // 2. Compute each player's season-to-date minutes and per-90 z-score rate
  const perPlayerSummary = players.map((p) => {
    const history = scoresByPlayer.get(p.playerSeasonId) ?? [];
    let minutes = 0;
    let starts = 0;
    let appearances = 0;
    let weightedZSum = 0;

    for (const h of history) {
      if (h.minutes > 0) {
        minutes += h.minutes;
        starts += h.starts;
        appearances += 1;
        // Weight each active appearance by its minutes share (or 1 per appearance)
        weightedZSum += h.zScore * Math.min(1.5, h.minutes / 90);
      }
    }

    const n90s = minutes / 90;
    const ownRatePer90 = n90s > 0 ? weightedZSum / n90s : 0;

    return {
      player: p,
      history,
      minutes,
      starts,
      appearances,
      ownRatePer90,
    };
  });

  // 3. Positional median priors (R3.3)
  const priors = computeCohortMedianPriors(
    perPlayerSummary.map((item) => ({
      position: item.player.position,
      minutes: item.minutes,
      ownRatePer90: item.ownRatePer90,
    })),
  );

  // 4. Evaluate each player's B_p, F_p, M_p, and V_p
  return perPlayerSummary.map(({ player, history, minutes, starts, appearances, ownRatePer90 }) => {
    const baseline = computeBaselineShrinkage({
      minutes,
      ownRatePer90,
      cohortPrior: priors[player.position],
    });

    const playedScores = history
      .filter((h) => h.minutes > 0)
      .map((h) => ({ order: h.gameweekNumber, score: h.zScore, minutes: h.minutes }));
    const form = computeFormEwma(playedScores);

    // Build recent team fixture window over gameweeks [max(1, targetGameweek - 5) .. targetGameweek]
    const historyByGw = new Map(history.map((h) => [h.gameweekNumber, h]));
    const recentFixtures: RecentFixturePresence[] = [];
    for (let gw = 1; gw <= targetGameweek; gw++) {
      const h = historyByGw.get(gw);
      recentFixtures.push({
        order: gw,
        minutes: h?.minutes ?? 0,
        starts: h?.starts ?? 0,
      });
    }

    const availability = computeAvailabilityMultiplier({
      recentFixtures,
      seasonStarts: starts,
      seasonTeamFixtures: targetGameweek,
      status: useSnapshotStatus ? player.status : 'a',
      chanceOfPlayingNextRound: useSnapshotStatus ? player.chanceOfPlayingNextRound : null,
    });

    const fv = fairValue({
      position: player.position,
      baseline,
      form,
      availabilityMultiplier: availability.multiplier,
    });

    return {
      ...fv,
      playerSeasonId: player.playerSeasonId,
      fplId: player.fplId,
      webName: player.webName,
      fullName: `${player.firstName} ${player.secondName}`.trim(),
      clubSeasonId: player.clubSeasonId,
      clubShortName: player.clubShortName,
      position: player.position,
      minutes,
      starts,
      appearances,
      ownRatePer90,
      expectedMinutesShare: availability.expectedMinutesShare,
      availabilityFactor: availability.availabilityFactor,
    };
  });
}
