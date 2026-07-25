// Write a planned gameweek's live stats into player_fixture_stat and
// player_gameweek_stat, and archive the raw payload.
//
// Two resolutions happen here, both keyed on FPL's season-scoped ids exactly as
// R1.2/R1.3 left them: `element.id` → `player_season` on (seasonId, fplId), and
// `explain[].fixture` → `fixture` on (seasonId, fplId). Everything is resolved
// before anything is written, so a payload that references a player or fixture
// we've never ingested fails whole — an ordering problem, named — rather than
// leaving half a gameweek behind.
//
// This is the first table big enough to matter at backfill scale (~25k rows
// across 38 gameweeks), so the create path is chunked rather than issued as one
// statement.

import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { RawPayload } from '@/lib/fpl';
import { applyDiff, createInChunks, type SyncCounts } from '../diff';
import type { EventLivePlan } from './plan';

export type RawPayloadOutcome = 'created' | 'updated' | 'unchanged';

export type EventLiveSyncResult = {
  season: { id: number; startYear: number };
  gameweek: { id: number; number: number };
  fixtureStats: SyncCounts;
  gameweekStats: SyncCounts;
  /** Present only when a raw payload was handed in to archive. */
  raw?: RawPayloadOutcome;
  warnings: string[];
};

/**
 * Raised when a live payload references reference data that isn't in the
 * database. Always an ordering problem: bootstrap-static (R1.2) and fixtures
 * (R1.3) have to be ingested first.
 */
export class EventLiveSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventLiveSyncError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_WAIT_MS = 10_000;

export async function syncEventLive(
  prisma: PrismaClient,
  plan: EventLivePlan,
  options: {
    startYear: number;
    gameweekNumber: number;
    /** The archived response to persist alongside the parsed rows. */
    raw?: RawPayload;
    timeoutMs?: number;
    maxWaitMs?: number;
  },
): Promise<EventLiveSyncResult> {
  return prisma.$transaction((tx) => runSync(tx, plan, options), {
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxWait: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  });
}

async function runSync(
  tx: Prisma.TransactionClient,
  plan: EventLivePlan,
  options: { startYear: number; gameweekNumber: number; raw?: RawPayload },
): Promise<EventLiveSyncResult> {
  const { startYear, gameweekNumber } = options;

  const season = await tx.season.findUnique({ where: { startYear } });
  if (!season) {
    throw new EventLiveSyncError(
      `no season ${startYear} in the database — ingest bootstrap-static first`,
    );
  }

  const gameweek = await tx.gameweek.findUnique({
    where: { seasonId_number: { seasonId: season.id, number: gameweekNumber } },
  });
  if (!gameweek) {
    throw new EventLiveSyncError(
      `no gameweek ${gameweekNumber} for season ${startYear} — ingest bootstrap-static first`,
    );
  }

  const playerSeasonIdByFplId = new Map(
    (
      await tx.playerSeason.findMany({
        where: { seasonId: season.id },
        select: { id: true, fplId: true },
      })
    ).map((ps) => [ps.fplId, ps.id]),
  );

  const fixtureByFplId = new Map(
    (
      await tx.fixture.findMany({
        where: { seasonId: season.id },
        select: { id: true, fplId: true, gameweekId: true },
      })
    ).map((f) => [f.fplId, f]),
  );

  const warnings = [...plan.warnings];

  // Resolve every reference up front. A single unknown player or fixture is an
  // ordering failure for the whole gameweek, not a row to skip.
  const missing: string[] = [];
  for (const stat of plan.gameweekStats) {
    if (!playerSeasonIdByFplId.has(stat.playerFplId)) {
      missing.push(`no player_season with fplId ${stat.playerFplId} in ${startYear}`);
    }
  }
  for (const stat of plan.fixtureStats) {
    if (!playerSeasonIdByFplId.has(stat.playerFplId)) {
      missing.push(`no player_season with fplId ${stat.playerFplId} in ${startYear}`);
    }
    const fixture = fixtureByFplId.get(stat.fixtureFplId);
    if (!fixture) {
      missing.push(`no fixture with fplId ${stat.fixtureFplId} in ${startYear}`);
    } else if (fixture.gameweekId !== null && fixture.gameweekId !== gameweek.id) {
      // The player's stat line for this GW points at a fixture our fixtures
      // ingest filed under a different gameweek. A postponement caught mid-move
      // can do this; it warns rather than fails, and the row is still attached
      // to the gameweek we're actually ingesting.
      warnings.push(
        `fixture ${stat.fixtureFplId} is filed under a different gameweek than ${gameweekNumber}`,
      );
    }
  }
  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    const shown = unique.slice(0, 5).join('; ');
    const more = unique.length > 5 ? ` (+${unique.length - 5} more)` : '';
    throw new EventLiveSyncError(
      `live payload references data that is not in the database — ${shown}${more}`,
    );
  }

  const psId = (fplId: number) => playerSeasonIdByFplId.get(fplId) as number;

  const gameweekStats = await applyDiff({
    planned: plan.gameweekStats,
    existing: await tx.playerGameweekStat.findMany({ where: { gameweekId: gameweek.id } }),
    keyOfPlanned: (stat) => String(psId(stat.playerFplId)),
    keyOfExisting: (row) => String(row.playerSeasonId),
    dataOf: (stat) =>
      ({
        playerSeasonId: psId(stat.playerFplId),
        gameweekId: gameweek.id,
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
        bps: stat.bps,
        tackles: stat.tackles,
        recoveries: stat.recoveries,
        clearancesBlocksInterceptions: stat.clearancesBlocksInterceptions,
        defensiveContribution: stat.defensiveContribution,
        influence: stat.influence,
        creativity: stat.creativity,
        threat: stat.threat,
        ictIndex: stat.ictIndex,
        expectedGoals: stat.expectedGoals,
        expectedAssists: stat.expectedAssists,
        expectedGoalInvolvements: stat.expectedGoalInvolvements,
        expectedGoalsConceded: stat.expectedGoalsConceded,
        totalPoints: stat.totalPoints,
      }) satisfies Prisma.PlayerGameweekStatCreateManyInput,
    createMany: (rows) =>
      createInChunks((chunk) => tx.playerGameweekStat.createMany({ data: chunk }), rows),
    update: (id, data) => tx.playerGameweekStat.update({ where: { id }, data }),
  });

  const fixtureStats = await applyDiff({
    planned: plan.fixtureStats,
    existing: await tx.playerFixtureStat.findMany({ where: { gameweekId: gameweek.id } }),
    keyOfPlanned: (stat) =>
      `${psId(stat.playerFplId)}:${(fixtureByFplId.get(stat.fixtureFplId) as { id: number }).id}`,
    keyOfExisting: (row) => `${row.playerSeasonId}:${row.fixtureId}`,
    dataOf: (stat) =>
      ({
        playerSeasonId: psId(stat.playerFplId),
        fixtureId: (fixtureByFplId.get(stat.fixtureFplId) as { id: number }).id,
        gameweekId: gameweek.id,
        minutes: stat.minutes,
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
      }) satisfies Prisma.PlayerFixtureStatCreateManyInput,
    createMany: (rows) =>
      createInChunks((chunk) => tx.playerFixtureStat.createMany({ data: chunk }), rows),
    update: (id, data) => tx.playerFixtureStat.update({ where: { id }, data }),
  });

  let raw: RawPayloadOutcome | undefined;
  if (options.raw) {
    raw = await storeRaw(tx, options.raw, `${startYear}:gw${gameweekNumber}`);
  }

  return {
    season: { id: season.id, startYear },
    gameweek: { id: gameweek.id, number: gameweekNumber },
    fixtureStats,
    gameweekStats,
    raw,
    warnings,
  };
}

/**
 * Archive a raw payload, keyed on (endpoint, scopeKey). Re-fetching a finished
 * gameweek pulls byte-identical data, so the `bodyHash` short-circuits and the
 * row is left untouched — which is what keeps R1.7's full-backfill idempotency
 * honest even though the payload also carries volatile fetch metadata.
 */
async function storeRaw(
  tx: Prisma.TransactionClient,
  payload: RawPayload,
  scopeKey: string,
): Promise<RawPayloadOutcome> {
  const bodyHash = createHash('sha256').update(JSON.stringify(payload.body)).digest('hex');
  const existing = await tx.rawPayload.findUnique({
    where: { endpoint_scopeKey: { endpoint: payload.endpoint, scopeKey } },
    select: { id: true, bodyHash: true },
  });

  const data = {
    endpoint: payload.endpoint,
    scopeKey,
    url: payload.url,
    status: payload.status,
    fetchedAt: new Date(payload.fetchedAt),
    bytes: payload.bytes,
    attempts: payload.attempts,
    bodyHash,
    body: payload.body as Prisma.InputJsonValue,
  };

  if (!existing) {
    await tx.rawPayload.create({ data });
    return 'created';
  }
  if (existing.bodyHash === bodyHash) return 'unchanged';
  await tx.rawPayload.update({ where: { id: existing.id }, data });
  return 'updated';
}
