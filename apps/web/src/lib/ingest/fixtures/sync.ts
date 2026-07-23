// Write planned fixtures into the fixture table.
//
// Fixtures are the first table later syncs genuinely mutate: a row is created
// as a scheduled match with no score, and the same row later gains a kickoff
// that moved, a scoreline, `started`, `finished`, and eventually a gameweek it
// was rescheduled into. So this path is the one where `applyDiff`'s
// read-before-write earns its keep — an hourly cron over 380 fixtures writes
// only the handful that actually moved.

import type { Prisma, PrismaClient } from '@prisma/client';
import { applyDiff, type SyncCounts } from '../diff';
import type { FixturesPlan } from './plan';

export type FixturesSyncResult = {
  season: { id: number; startYear: number };
  fixtures: SyncCounts;
  /** Fixtures FPL has not yet scheduled into a gameweek. */
  unscheduled: number;
  warnings: string[];
};

/**
 * Raised when the reference data a fixture points at isn't in the database.
 * Always an ordering problem: bootstrap-static has to be ingested first, since
 * it is what creates the season, its clubs and its gameweeks.
 */
export class FixturesSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixturesSyncError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_WAIT_MS = 10_000;

export async function syncFixtures(
  prisma: PrismaClient,
  plan: FixturesPlan,
  options: { startYear: number; timeoutMs?: number; maxWaitMs?: number },
): Promise<FixturesSyncResult> {
  return prisma.$transaction(async (tx) => runSync(tx, plan, options.startYear), {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxWait: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  });
}

async function runSync(
  tx: Prisma.TransactionClient,
  plan: FixturesPlan,
  startYear: number,
): Promise<FixturesSyncResult> {
  const season = await tx.season.findUnique({ where: { startYear } });
  if (!season) {
    throw new FixturesSyncError(
      `no season ${startYear} in the database — ingest bootstrap-static first`,
    );
  }

  const clubSeasonIdByFplId = new Map(
    (
      await tx.clubSeason.findMany({
        where: { seasonId: season.id },
        select: { id: true, fplId: true },
      })
    ).map((cs) => [cs.fplId, cs.id]),
  );

  const gameweekIdByNumber = new Map(
    (
      await tx.gameweek.findMany({
        where: { seasonId: season.id },
        select: { id: true, number: true },
      })
    ).map((gw) => [gw.number, gw.id]),
  );

  // Resolve everything before writing anything, so a payload referencing a club
  // we have never seen fails without leaving half a matchweek behind.
  const missing: string[] = [];
  for (const fixture of plan.fixtures) {
    for (const [side, fplId] of [
      ['home', fixture.homeClubFplId],
      ['away', fixture.awayClubFplId],
    ] as const) {
      if (!clubSeasonIdByFplId.has(fplId)) {
        missing.push(`fixture ${fixture.fplId}: no ${side} club with fplId ${fplId} in ${startYear}`);
      }
    }
    if (fixture.gameweekNumber !== null && !gameweekIdByNumber.has(fixture.gameweekNumber)) {
      missing.push(`fixture ${fixture.fplId}: no gameweek ${fixture.gameweekNumber} in ${startYear}`);
    }
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join('; ');
    const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
    throw new FixturesSyncError(
      `fixtures reference data that is not in the database — ${shown}${more}`,
    );
  }

  const fixtures = await applyDiff({
    planned: plan.fixtures,
    existing: await tx.fixture.findMany({ where: { seasonId: season.id } }),
    keyOfPlanned: (fixture) => String(fixture.fplId),
    keyOfExisting: (row) => String(row.fplId),
    dataOf: (fixture) =>
      ({
        seasonId: season.id,
        gameweekId:
          fixture.gameweekNumber === null
            ? null
            : (gameweekIdByNumber.get(fixture.gameweekNumber) as number),
        fplId: fixture.fplId,
        code: fixture.code,
        homeClubSeasonId: clubSeasonIdByFplId.get(fixture.homeClubFplId) as number,
        awayClubSeasonId: clubSeasonIdByFplId.get(fixture.awayClubFplId) as number,
        kickoffTime: fixture.kickoffTime,
        started: fixture.started,
        finished: fixture.finished,
        finishedProvisional: fixture.finishedProvisional,
        provisionalStartTime: fixture.provisionalStartTime,
        minutes: fixture.minutes,
        homeScore: fixture.homeScore,
        awayScore: fixture.awayScore,
        homeDifficulty: fixture.homeDifficulty,
        awayDifficulty: fixture.awayDifficulty,
      }) satisfies Prisma.FixtureCreateManyInput,
    createMany: (rows) => tx.fixture.createMany({ data: rows }),
    update: (id, data) => tx.fixture.update({ where: { id }, data }),
  });

  return {
    season: { id: season.id, startYear },
    fixtures,
    unscheduled: plan.fixtures.filter((fixture) => fixture.gameweekNumber === null).length,
    warnings: plan.warnings,
  };
}
