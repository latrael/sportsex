// R2.3's aggregation, tested where it is pure: rows in, one row per player out.
// The database half (diffing, idempotency, invariant 4 at season scale) lives in
// integration/derive-season-stats.test.ts.

import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { planSeasonStats, SeasonStatsPlanError } from '@/lib/derive';
import type { FixtureStatRow, GameweekStatRow } from '@/lib/derive';

function fixtureRow(o: Partial<FixtureStatRow> = {}): FixtureStatRow {
  return {
    playerSeasonId: 1,
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
    defensiveContribution: 0,
    totalPoints: 2,
    ...o,
  };
}

function gameweekRow(o: Partial<GameweekStatRow> = {}): GameweekStatRow {
  return {
    playerSeasonId: 1,
    minutes: 90,
    starts: 1,
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
    bps: 0,
    tackles: 0,
    recoveries: 0,
    clearancesBlocksInterceptions: 0,
    defensiveContribution: 0,
    totalPoints: 2,
    influence: '0',
    creativity: '0',
    threat: '0',
    ictIndex: '0',
    expectedGoals: '0',
    expectedAssists: '0',
    expectedGoalInvolvements: '0',
    expectedGoalsConceded: '0',
    ...o,
  };
}

function plan(input: {
  playerSeasonIds?: number[];
  fixtureStats?: FixtureStatRow[];
  gameweekStats?: GameweekStatRow[];
}) {
  return planSeasonStats({
    playerSeasonIds: input.playerSeasonIds ?? [1],
    fixtureStats: input.fixtureStats ?? [],
    gameweekStats: input.gameweekStats ?? [],
  });
}

describe('planSeasonStats — counting stats', () => {
  it('sums the counting stats from the gameweek grain', () => {
    const { stats } = plan({
      fixtureStats: [
        fixtureRow({ minutes: 90, goalsScored: 2, assists: 1, bonus: 3, totalPoints: 15 }),
        fixtureRow({ minutes: 62, goalsScored: 1, yellowCards: 1, totalPoints: 7 }),
      ],
      gameweekStats: [
        gameweekRow({
          minutes: 152,
          goalsScored: 3,
          assists: 1,
          yellowCards: 1,
          bonus: 3,
          totalPoints: 22,
        }),
      ],
    });

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      playerSeasonId: 1,
      appearances: 2,
      minutes: 152,
      goalsScored: 3,
      assists: 1,
      yellowCards: 1,
      bonus: 3,
      totalPoints: 22,
    });
  });

  it('takes the conditionally-scoring stats from the gameweek grain, not explain', () => {
    // The live `explain` block is a points ledger: a keeper's 2 saves and a
    // defender's 1 goal conceded score nothing, so FPL omits them per fixture.
    // Summing the per-fixture grain would lose exactly the defensive stats R3.1
    // is built from.
    const { stats, warnings } = plan({
      fixtureStats: [
        fixtureRow({ minutes: 90, saves: 0, goalsConceded: 0, cleanSheets: 0, totalPoints: 2 }),
      ],
      gameweekStats: [
        gameweekRow({
          minutes: 90,
          saves: 2,
          goalsConceded: 1,
          cleanSheets: 0,
          defensiveContribution: 8,
          totalPoints: 2,
        }),
      ],
    });

    expect(stats[0]).toMatchObject({
      saves: 2,
      goalsConceded: 1,
      defensiveContribution: 8,
      totalPoints: 2,
    });
    // A shortfall in a conditionally-scoring stat is normal, not a warning.
    expect(warnings).toEqual([]);
  });

  it('counts an appearance per fixture with minutes, not per start', () => {
    const { stats } = plan({
      fixtureStats: [
        fixtureRow({ minutes: 90 }),
        fixtureRow({ minutes: 12 }), // substitute — still an appearance
        fixtureRow({ minutes: 0 }), // unused bench — not an appearance
      ],
      gameweekStats: [gameweekRow({ minutes: 102, starts: 1, totalPoints: 6 })],
    });

    expect(stats[0].appearances).toBe(2);
    expect(stats[0].starts).toBe(1);
    expect(stats[0].minutes).toBe(102);
  });

  it('counts a double gameweek as two appearances from one gameweek row', () => {
    const { stats } = plan({
      fixtureStats: [
        fixtureRow({ minutes: 90, goalsScored: 1, totalPoints: 8 }),
        fixtureRow({ minutes: 90, assists: 1, totalPoints: 5 }),
      ],
      gameweekStats: [
        gameweekRow({
          minutes: 180,
          starts: 2,
          goalsScored: 1,
          assists: 1,
          totalPoints: 13,
          expectedGoals: '0.71',
        }),
      ],
    });

    expect(stats[0]).toMatchObject({ appearances: 2, minutes: 180, starts: 2, totalPoints: 13 });
    // The gameweek row already covers both fixtures, so it is summed once.
    expect(stats[0].expectedGoals.toString()).toBe('0.71');
  });
});

describe('planSeasonStats — model inputs', () => {
  it('sums the gameweek-grain model inputs and keeps Decimal exact', () => {
    const { stats } = plan({
      fixtureStats: [fixtureRow(), fixtureRow(), fixtureRow()],
      gameweekStats: [
        gameweekRow({ bps: 31, tackles: 2, expectedGoals: '0.11', ictIndex: '10.4' }),
        gameweekRow({ bps: 12, recoveries: 5, expectedGoals: '0.22', ictIndex: '3.6' }),
        gameweekRow({
          bps: 7,
          clearancesBlocksInterceptions: 4,
          expectedGoals: '0.07',
          ictIndex: '1.2',
        }),
      ],
    });

    expect(stats[0]).toMatchObject({
      bps: 50,
      tackles: 2,
      recoveries: 5,
      clearancesBlocksInterceptions: 4,
    });
    // 0.11 + 0.22 + 0.07 is 0.4 exactly in Decimal, 0.4000000000000001 in float.
    expect(stats[0].expectedGoals.equals(new Prisma.Decimal('0.40'))).toBe(true);
    expect(stats[0].expectedGoals.toString()).toBe('0.4');
    expect(stats[0].ictIndex.toString()).toBe('15.2');
  });

  it('never takes the model inputs from the per-fixture grain', () => {
    // They don't exist there; a fixture row can't move bps or xG.
    const { stats } = plan({
      fixtureStats: [fixtureRow({ minutes: 90 }), fixtureRow({ minutes: 90 })],
      gameweekStats: [gameweekRow({ minutes: 180, starts: 2, bps: 20, expectedGoals: '0.5' })],
    });
    expect(stats[0].bps).toBe(20);
    expect(stats[0].expectedGoals.toString()).toBe('0.5');
  });
});

describe('planSeasonStats — membership', () => {
  it('emits a zeroed row for a player with no event rows at all', () => {
    const { stats } = plan({ playerSeasonIds: [1, 2], fixtureStats: [fixtureRow()] });

    const idle = stats.find((s) => s.playerSeasonId === 2)!;
    expect(idle).toMatchObject({ appearances: 0, minutes: 0, starts: 0, totalPoints: 0 });
    expect(idle.expectedGoals.toString()).toBe('0');
  });

  it('emits exactly one row per player in the season', () => {
    const { stats } = plan({
      playerSeasonIds: [1, 2, 3],
      fixtureStats: [fixtureRow({ playerSeasonId: 1 }), fixtureRow({ playerSeasonId: 3 })],
      gameweekStats: [gameweekRow({ playerSeasonId: 1 }), gameweekRow({ playerSeasonId: 3 })],
    });
    expect(stats.map((s) => s.playerSeasonId).sort()).toEqual([1, 2, 3]);
  });

  it('fails whole on an event row for a player outside the season', () => {
    expect(() => plan({ playerSeasonIds: [1], fixtureStats: [fixtureRow({ playerSeasonId: 9 })] }))
      .toThrow(SeasonStatsPlanError);
    expect(() =>
      plan({ playerSeasonIds: [1], gameweekStats: [gameweekRow({ playerSeasonId: 9 })] }),
    ).toThrow(/not in this season/);
  });
});

describe('planSeasonStats — cross-grain check', () => {
  it('is silent when the two grains agree', () => {
    const { warnings } = plan({
      fixtureStats: [fixtureRow({ minutes: 90, goalsScored: 1, totalPoints: 8 })],
      gameweekStats: [gameweekRow({ minutes: 90, goalsScored: 1, totalPoints: 8 })],
    });
    expect(warnings).toEqual([]);
  });

  it('warns when an always-scoring stat disagrees in either direction', () => {
    // Minutes always score, so `explain` reports them in full: a shortfall means
    // a fixture was lost between the grains.
    const { warnings, stats } = plan({
      fixtureStats: [fixtureRow({ minutes: 90, goalsScored: 1, totalPoints: 8 })],
      gameweekStats: [gameweekRow({ minutes: 180, goalsScored: 1, totalPoints: 8 })],
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/minutes sums to 90 per fixture but 180 per gameweek/);
    // The aggregate is still taken from the complete grain: it warns, it doesn't guess.
    expect(stats[0].minutes).toBe(180);
  });

  it('warns when the per-fixture grain exceeds the gameweek total', () => {
    // The one direction that is always a fault, even for a conditional stat:
    // a fixture counted twice.
    const { warnings } = plan({
      fixtureStats: [
        fixtureRow({ minutes: 90, saves: 3, totalPoints: 3 }),
        fixtureRow({ minutes: 0, saves: 3, totalPoints: 0 }),
      ],
      gameweekStats: [gameweekRow({ minutes: 90, saves: 3, totalPoints: 3 })],
    });

    expect(warnings).toEqual([
      'playerSeasonId 1: saves sums to 6 per fixture but 3 per gameweek',
    ]);
  });
});

describe('planSeasonStats — purity', () => {
  it('is deterministic: the same rows produce the same plan', () => {
    const input = {
      playerSeasonIds: [1, 2],
      fixtureStats: [
        fixtureRow({ minutes: 71, goalsScored: 1, totalPoints: 9 }),
        fixtureRow({ playerSeasonId: 2, minutes: 90, saves: 4, totalPoints: 5 }),
      ],
      gameweekStats: [
        gameweekRow({ minutes: 71, goalsScored: 1, totalPoints: 9, expectedGoals: '0.33' }),
        gameweekRow({ playerSeasonId: 2, minutes: 90, saves: 4, totalPoints: 5, bps: 18 }),
      ],
    };
    expect(JSON.stringify(planSeasonStats(input))).toEqual(JSON.stringify(planSeasonStats(input)));
  });

  it('does not mutate its input rows', () => {
    const fixtureStats = [fixtureRow({ minutes: 90, goalsScored: 1 })];
    const gameweekStats = [gameweekRow({ minutes: 90, goalsScored: 1, bps: 24 })];
    const before = JSON.stringify({ fixtureStats, gameweekStats });
    planSeasonStats({ playerSeasonIds: [1], fixtureStats, gameweekStats });
    expect(JSON.stringify({ fixtureStats, gameweekStats })).toBe(before);
  });
});
