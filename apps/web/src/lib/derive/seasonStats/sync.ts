// R2.3 — read a season's event rows, recompute every aggregate, write only what
// moved.
//
// There is no atomic increment in this path and there never will be. The whole
// function is: read the immutable rows, compute the answer from scratch, diff it
// against what's stored. That is what makes invariant 4 ("recomputing season
// aggregates from the event rows reproduces the stored aggregates exactly") a
// property of the design rather than something to go and check — a second run
// reports zero writes because the first run's output was already the function of
// the inputs, not an accumulation of them.
//
// Both event tables are read: see plan.ts for why the counting stats come from
// the gameweek grain and only `appearances` from the per-fixture grain.
//
// `check` mode plans and diffs without writing, so the same code answers "does
// the stored table still agree with the events?" That is the query R7.5's daily
// production reconciliation needs, and it's free because planning is pure.

import type { Prisma, PrismaClient } from '@prisma/client';
import { applyDiff, createInChunks, type SyncCounts } from '@/lib/ingest';
import { planSeasonStats, type PlannedSeasonStat, type SeasonStatsPlan } from './plan';

export type SeasonStatsSyncResult = {
  season: { id: number; startYear: number };
  seasonStats: SyncCounts;
  /** Players whose stored aggregate disagrees with the recompute. */
  drifted: number[];
  warnings: string[];
};

/** Raised when the requested season isn't in the database. */
export class SeasonStatsSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonStatsSyncError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_WAIT_MS = 10_000;

/**
 * Recompute `player_season_stat` for one season.
 *
 * With `check: true` nothing is written: the counts describe what a real run
 * *would* do, and `drifted` names the players whose stored row no longer matches
 * the events. `created` in check mode means "a player has no stored aggregate".
 */
export async function recomputeSeasonStats(
  prisma: PrismaClient,
  options: {
    startYear: number;
    check?: boolean;
    now?: () => Date;
    timeoutMs?: number;
    maxWaitMs?: number;
  },
): Promise<SeasonStatsSyncResult> {
  return prisma.$transaction((tx) => run(tx, options), {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxWait: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  });
}

async function run(
  tx: Prisma.TransactionClient,
  options: { startYear: number; check?: boolean; now?: () => Date },
): Promise<SeasonStatsSyncResult> {
  const { startYear, check = false } = options;
  // One stamp for the whole run: every row this recompute moves was computed
  // from the same read of the same events.
  const computedAt = (options.now ?? (() => new Date()))();

  const season = await tx.season.findUnique({ where: { startYear } });
  if (!season) {
    throw new SeasonStatsSyncError(`no season ${startYear} in the database`);
  }

  const playerSeasons = await tx.playerSeason.findMany({
    where: { seasonId: season.id },
    select: { id: true },
  });
  const playerSeasonIds = playerSeasons.map((ps) => ps.id);

  // Scoped by season through the gameweek, so a multi-season database
  // recomputes one season without touching the others.
  const fixtureStats = await tx.playerFixtureStat.findMany({
    where: { gameweek: { seasonId: season.id } },
    select: FIXTURE_SELECT,
  });
  const gameweekStats = await tx.playerGameweekStat.findMany({
    where: { gameweek: { seasonId: season.id } },
    select: GAMEWEEK_SELECT,
  });

  const plan: SeasonStatsPlan = planSeasonStats({
    playerSeasonIds,
    fixtureStats,
    gameweekStats,
  });

  const existing = await tx.playerSeasonStat.findMany({
    where: { playerSeason: { seasonId: season.id } },
  });

  const drifted: number[] = [];
  const seasonStats = await applyDiff({
    planned: plan.stats,
    existing,
    keyOfPlanned: (stat) => String(stat.playerSeasonId),
    keyOfExisting: (row) => String(row.playerSeasonId),
    dataOf: (stat) => rowFor(stat, computedAt),
    // `computedAt` is written but never compared: it records when this
    // aggregate last *moved*, so an unchanged player is not rewritten and a
    // no-op recompute really is a no-op (see applyDiff).
    omitFromCompare: ['computedAt'],
    createMany: (rows) =>
      check
        ? noteDrift(drifted, rows)
        : createInChunks((chunk) => tx.playerSeasonStat.createMany({ data: chunk }), rows),
    update: (id, data) => {
      if (check) return noteDrift(drifted, [data]);
      return tx.playerSeasonStat.update({ where: { id }, data });
    },
  });

  return {
    season: { id: season.id, startYear },
    seasonStats,
    drifted,
    warnings: plan.warnings,
  };
}

async function noteDrift(
  drifted: number[],
  rows: readonly { playerSeasonId: number }[],
): Promise<void> {
  for (const row of rows) drifted.push(row.playerSeasonId);
}

function rowFor(stat: PlannedSeasonStat, computedAt: Date): Prisma.PlayerSeasonStatCreateManyInput {
  return {
    playerSeasonId: stat.playerSeasonId,
    appearances: stat.appearances,
    minutes: stat.minutes,
    starts: stat.starts,
    goalsScored: stat.goalsScored,
    assists: stat.assists,
    cleanSheets: stat.cleanSheets,
    goalsConceded: stat.goalsConceded,
    ownGoals: stat.ownGoals,
    penaltiesSaved: stat.penaltiesSaved,
    penaltiesMissed: stat.penaltiesMissed,
    yellowCards: stat.yellowCards,
    redCards: stat.redCards,
    saves: stat.saves,
    bonus: stat.bonus,
    defensiveContribution: stat.defensiveContribution,
    totalPoints: stat.totalPoints,
    bps: stat.bps,
    tackles: stat.tackles,
    recoveries: stat.recoveries,
    clearancesBlocksInterceptions: stat.clearancesBlocksInterceptions,
    influence: stat.influence,
    creativity: stat.creativity,
    threat: stat.threat,
    ictIndex: stat.ictIndex,
    expectedGoals: stat.expectedGoals,
    expectedAssists: stat.expectedAssists,
    expectedGoalInvolvements: stat.expectedGoalInvolvements,
    expectedGoalsConceded: stat.expectedGoalsConceded,
    computedAt,
  };
}

const FIXTURE_SELECT = {
  playerSeasonId: true,
  minutes: true,
  goalsScored: true,
  assists: true,
  cleanSheets: true,
  goalsConceded: true,
  ownGoals: true,
  penaltiesSaved: true,
  penaltiesMissed: true,
  yellowCards: true,
  redCards: true,
  saves: true,
  bonus: true,
  defensiveContribution: true,
  totalPoints: true,
} satisfies Prisma.PlayerFixtureStatSelect;

const GAMEWEEK_SELECT = {
  playerSeasonId: true,
  minutes: true,
  starts: true,
  goalsScored: true,
  assists: true,
  cleanSheets: true,
  goalsConceded: true,
  ownGoals: true,
  penaltiesSaved: true,
  penaltiesMissed: true,
  yellowCards: true,
  redCards: true,
  saves: true,
  bonus: true,
  bps: true,
  tackles: true,
  recoveries: true,
  clearancesBlocksInterceptions: true,
  defensiveContribution: true,
  totalPoints: true,
  influence: true,
  creativity: true,
  threat: true,
  ictIndex: true,
  expectedGoals: true,
  expectedAssists: true,
  expectedGoalInvolvements: true,
  expectedGoalsConceded: true,
} satisfies Prisma.PlayerGameweekStatSelect;
