import { describe, it, expect } from 'vitest';
import {
  POSITION_WEIGHTS,
  POSITION_BASE_PRICE,
  VALUATION_PARAMS,
  computeRawPerformance,
  scorePerformanceCohort,
  computeFormEwma,
  computeBaselineShrinkage,
  computeCohortMedianPriors,
  computeStatusFactor,
  computeAvailabilityMultiplier,
  fairValue,
  clubFairValue,
  evaluateLeagueAtGameweek,
  type PerformanceStatInput,
} from '@/lib/valuation';

function makeStat(overrides: Partial<PerformanceStatInput> = {}): PerformanceStatInput {
  return {
    playerSeasonId: 1,
    gameweekNumber: 1,
    position: 'FWD',
    minutes: 90,
    goalsScored: 0,
    assists: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    ownGoals: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    yellowCards: 0,
    redCards: 0,
    saves: 0,
    bonus: 0,
    tackles: 0,
    recoveries: 0,
    clearancesBlocksInterceptions: 0,
    defensiveContribution: 0,
    expectedGoals: '0.00',
    expectedAssists: '0.00',
    expectedGoalsConceded: '0.00',
    threat: '0.00',
    creativity: '0.00',
    ...overrides,
  };
}

describe('Phase 3 Valuation Engine (R3.1–R3.8)', () => {
  describe('R3.1 & R3.8 — Position-normalised performance score', () => {
    it('returns zero components for 0-minute appearances and excludes them from cohort z-scoring', () => {
      const rows: PerformanceStatInput[] = [
        makeStat({ playerSeasonId: 1, position: 'FWD', minutes: 90, goalsScored: 2, expectedGoals: '1.40', bonus: 3 }),
        makeStat({ playerSeasonId: 2, position: 'FWD', minutes: 90, goalsScored: 1, expectedGoals: '0.70', bonus: 1 }),
        makeStat({ playerSeasonId: 3, position: 'FWD', minutes: 90, goalsScored: 0, expectedGoals: '0.10', yellowCards: 1 }),
        makeStat({ playerSeasonId: 4, position: 'FWD', minutes: 0, goalsScored: 0 }), // bench
      ];

      const { scores, cohorts } = scorePerformanceCohort(rows);
      expect(cohorts.FWD.count).toBe(3);

      const active = scores.filter((s) => s.minutes > 0);
      const mean = active.reduce((a, s) => a + s.zScore, 0) / active.length;
      const variance = active.reduce((a, s) => a + (s.zScore - mean) ** 2, 0) / active.length;

      expect(mean).toBeCloseTo(0, 10);
      expect(Math.sqrt(variance)).toBeCloseTo(1, 10);
      expect(scores.find((s) => s.playerSeasonId === 4)?.zScore).toBe(0);
    });

    it('standardises each position group independently so GK clean sheets + saves map to the same z-scale as FWD goals', () => {
      const rows: PerformanceStatInput[] = [
        makeStat({ playerSeasonId: 1, position: 'GKP', minutes: 90, cleanSheets: 1, saves: 6, bonus: 3 }),
        makeStat({ playerSeasonId: 2, position: 'GKP', minutes: 90, cleanSheets: 0, saves: 2, goalsConceded: 2 }),
        makeStat({ playerSeasonId: 3, position: 'DEF', minutes: 90, cleanSheets: 1, tackles: 5, clearancesBlocksInterceptions: 8, recoveries: 6 }),
        makeStat({ playerSeasonId: 4, position: 'DEF', minutes: 90, cleanSheets: 0, goalsConceded: 3, yellowCards: 1 }),
        makeStat({ playerSeasonId: 5, position: 'MID', minutes: 90, goalsScored: 1, assists: 1, expectedGoals: '0.5', expectedAssists: '0.6' }),
        makeStat({ playerSeasonId: 6, position: 'MID', minutes: 90, yellowCards: 1, tackles: 1 }),
        makeStat({ playerSeasonId: 7, position: 'FWD', minutes: 90, goalsScored: 2, expectedGoals: '1.2' }),
        makeStat({ playerSeasonId: 8, position: 'FWD', minutes: 90, goalsScored: 0, expectedGoals: '0.1' }),
      ];

      const { scores } = scorePerformanceCohort(rows);
      for (const pos of ['GKP', 'DEF', 'MID', 'FWD'] as const) {
        const posScores = scores.filter((s) => s.position === pos);
        const mean = posScores.reduce((a, s) => a + s.zScore, 0) / posScores.length;
        const sd = Math.sqrt(posScores.reduce((a, s) => a + (s.zScore - mean) ** 2, 0) / posScores.length);
        expect(mean).toBeCloseTo(0, 10);
        expect(sd).toBeCloseTo(1, 10);
      }

      // Verify R3.8 weights: GK clean sheet (0.85) + 3 saves (0.66) > 1.5 raw points
      const gkRaw = computeRawPerformance(rows[0]);
      expect(gkRaw.defence).toBeGreaterThan(1.5);
      expect(POSITION_WEIGHTS.GKP.cleanSheets).toBe(0.85);
      expect(POSITION_WEIGHTS.DEF.cleanSheets).toBe(0.75);
      expect(POSITION_WEIGHTS.MID.cleanSheets).toBe(0.25);
      expect(POSITION_WEIGHTS.FWD.cleanSheets).toBe(0);
    });
  });

  describe('R3.2 — EWMA form', () => {
    it('matches a hand-computed sequence with half-life = 4 matches', () => {
      // Chronological sequence: [oldest = 1.0, middle = 2.0, newest = 4.0]
      // matches_ago: newest -> 0 (w = 0.5^(0/4) = 1)
      //              middle -> 1 (w = 0.5^(1/4))
      //              oldest -> 2 (w = 0.5^(2/4) = sqrt(0.5))
      const w0 = 1;
      const w1 = Math.pow(0.5, 1 / 4);
      const w2 = Math.pow(0.5, 2 / 4);
      const expected = (w2 * 1.0 + w1 * 2.0 + w0 * 4.0) / (w2 + w1 + w0);

      const actual = computeFormEwma([1.0, 2.0, 4.0], 4);
      expect(actual).toBeCloseTo(expected, 12);
    });

    it('sorts FormObservation items by order and ignores 0-minute bench entries', () => {
      const obs = [
        { order: 3, score: 2.0, minutes: 90 },
        { order: 1, score: -1.0, minutes: 90 },
        { order: 2, score: 99.0, minutes: 0 }, // bench -> ignored
      ];
      // Played sequence is [-1.0, 2.0] -> matches_ago 1 and 0
      const w0 = 1;
      const w1 = Math.pow(0.5, 1 / 4);
      const expected = (w1 * -1.0 + w0 * 2.0) / (w1 + w0);
      expect(computeFormEwma(obs, 4)).toBeCloseTo(expected, 12);
    });
  });

  describe('R3.3 — Shrinkage baseline', () => {
    it('keeps a 90-minute player within 10% of the positional median and converges monotonically in minutes', () => {
      const cohortPrior = 1.0; // positional median reference
      const ownRate = 1.5; // +50% above median
      const at90 = computeBaselineShrinkage({
        minutes: 90,
        ownRatePer90: ownRate,
        cohortPrior,
        k90s: 6,
      });

      // (1 * 1.5 + 6 * 1.0) / 7 = 7.5 / 7 = 1.0714 -> +7.14% from cohortPrior (< 10%)
      expect(Math.abs(at90 - cohortPrior) / cohortPrior).toBeLessThan(0.1);

      // Monotone convergence toward ownRate as minutes increase
      const minsList = [0, 90, 270, 540, 900, 1800, 3420];
      const values = minsList.map((minutes) =>
        computeBaselineShrinkage({ minutes, ownRatePer90: ownRate, cohortPrior, k90s: 6 }),
      );
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1]);
        expect(values[i]).toBeLessThan(ownRate);
      }

      // Median helper
      const priors = computeCohortMedianPriors([
        { position: 'MID', minutes: 900, ownRatePer90: -0.5 },
        { position: 'MID', minutes: 900, ownRatePer90: 0.1 },
        { position: 'MID', minutes: 900, ownRatePer90: 0.8 },
      ]);
      expect(priors.MID).toBe(0.1);
    });
  });

  describe('R3.4 — Availability multiplier', () => {
    it('decays a player who stops appearing toward the floor over ~6 gameweeks', () => {
      const multipliers: number[] = [];
      for (let absentWeeks = 0; absentWeeks <= 6; absentWeeks++) {
        const recentFixtures = [];
        for (let i = 1; i <= 6 - absentWeeks; i++) {
          recentFixtures.push({ order: i, minutes: 90, starts: 1 });
        }
        for (let i = 7 - absentWeeks; i <= 6; i++) {
          recentFixtures.push({ order: i, minutes: 0, starts: 0 });
        }
        const res = computeAvailabilityMultiplier({
          recentFixtures,
          status: 'a',
        });
        multipliers.push(res.multiplier);
      }

      // At 0 absent weeks: multiplier = 1.0
      expect(multipliers[0]).toBeCloseTo(1.0, 5);
      // Monotonically non-increasing each week they don't appear, and strictly decreasing before hitting the floor
      for (let i = 1; i < multipliers.length; i++) {
        expect(multipliers[i]).toBeLessThanOrEqual(multipliers[i - 1]);
      }
      expect(multipliers[1]).toBeLessThan(multipliers[0]);
      expect(multipliers[4]).toBeLessThan(multipliers[1]);
      // At 6 absent weeks: reaches the playable floor (0.12)
      expect(multipliers[6]).toBeCloseTo(VALUATION_PARAMS.minPlayableMinutesFloor, 5);
    });

    it('drops immediately when FPL status is injured (i) or suspended (s)', () => {
      const recentFixtures = [1, 2, 3, 4, 5, 6].map((order) => ({ order, minutes: 90, starts: 1 }));
      const healthy = computeAvailabilityMultiplier({ recentFixtures, status: 'a' });
      const injured = computeAvailabilityMultiplier({ recentFixtures, status: 'i' });
      const suspended = computeAvailabilityMultiplier({ recentFixtures, status: 's' });
      const doubtful50 = computeAvailabilityMultiplier({
        recentFixtures,
        status: 'd',
        chanceOfPlayingNextRound: 50,
      });

      expect(healthy.multiplier).toBeCloseTo(1.0, 5);
      expect(injured.availabilityFactor).toBe(0.15);
      expect(injured.multiplier).toBeCloseTo(0.15, 5);
      expect(suspended.multiplier).toBeCloseTo(0.15, 5);
      expect(doubtful50.multiplier).toBeCloseTo(0.5, 5);
      expect(computeStatusFactor('u', null)).toBe(0.15);
    });
  });

  describe('R3.5 — Invariant 6: fairValue() is pure, deterministic, and clamped to [10, 1500]', () => {
    it('produces identical outputs for identical inputs and clamps extremes to [10, 1500]', () => {
      const input = {
        position: 'MID' as const,
        baseline: 0.85,
        form: 1.2,
        availabilityMultiplier: 0.95,
      };
      const first = fairValue(input);
      const second = fairValue(input);
      expect(first.value).toBe(second.value);
      expect(first.decimals.value.toString()).toBe(second.decimals.value.toString());

      const expectedRaw =
        POSITION_BASE_PRICE.MID *
        Math.exp(VALUATION_PARAMS.lambda * (0.6 * 0.85 + 0.4 * 1.2)) *
        0.95;
      expect(first.value).toBeCloseTo(expectedRaw, 4);

      // Upper clamp
      const high = fairValue({
        position: 'FWD',
        baseline: 5.0,
        form: 5.0,
        availabilityMultiplier: 1.0,
      });
      expect(high.value).toBe(1500);

      // Lower clamp
      const low = fairValue({
        position: 'GKP',
        baseline: -5.0,
        form: -5.0,
        availabilityMultiplier: 0.12,
      });
      expect(low.value).toBe(10);
    });

    it('computes clubFairValue deterministically from minutes-weighted squad + PPG + strength', () => {
      const res = clubFairValue({
        squad: [
          { fairValue: 400, minutes: 3000 },
          { fairValue: 200, minutes: 3000 },
          { fairValue: 20, minutes: 0 },
        ],
        recentPointsPerGame: 2.5,
        strengthOverallHome: 1300,
        strengthOverallAway: 1250,
      });
      expect(res.value).toBeGreaterThan(300);
      expect(res.value).toBeLessThanOrEqual(1500);
      expect(res.decimalValue.toFixed(4)).toBe(res.value.toFixed(4));
    });

    it('evaluates a multi-player league at a target gameweek end-to-end purely', () => {
      const evals = evaluateLeagueAtGameweek({
        players: [
          {
            playerSeasonId: 1,
            fplId: 1,
            webName: 'StrikerA',
            firstName: 'Striker',
            secondName: 'A',
            clubSeasonId: 10,
            clubShortName: 'ARS',
            position: 'FWD',
            status: 'a',
            chanceOfPlayingNextRound: 100,
            nowCost: 110,
          },
          {
            playerSeasonId: 2,
            fplId: 2,
            webName: 'StrikerB',
            firstName: 'Striker',
            secondName: 'B',
            clubSeasonId: 11,
            clubShortName: 'CHE',
            position: 'FWD',
            status: 'i',
            chanceOfPlayingNextRound: 0,
            nowCost: 60,
          },
        ],
        gameweekStatsUpToTarget: [
          { ...makeStat({ playerSeasonId: 1, gameweekNumber: 1, position: 'FWD', minutes: 90, goalsScored: 2, expectedGoals: '1.5' }), starts: 1 },
          { ...makeStat({ playerSeasonId: 2, gameweekNumber: 1, position: 'FWD', minutes: 90, goalsScored: 0, expectedGoals: '0.1' }), starts: 1 },
        ],
        targetGameweek: 1,
      });

      expect(evals).toHaveLength(2);
      expect(evals[0].value).toBeGreaterThan(evals[1].value);
    });
  });
});
