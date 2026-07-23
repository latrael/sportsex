// Write a planned bootstrap-static into the reference tables.
//
// One transaction, one pass per table, in foreign-key order. Every write goes
// through `applyDiff`, so a re-run against an unchanged payload issues no
// UPDATEs at all — see lib/ingest/diff.ts for why that matters.

import type { Prisma, PrismaClient } from '@prisma/client';
import { applyDiff, type SyncCounts } from '../diff';
import type { BootstrapPlan } from './plan';

export type BootstrapSyncResult = {
  season: { id: number; name: string; startYear: number; created: boolean };
  clubs: SyncCounts;
  clubSeasons: SyncCounts;
  players: SyncCounts;
  playerSeasons: SyncCounts;
  gameweeks: SyncCounts;
  warnings: string[];
};

/** Everything in a bootstrap sync is one unit of work, so it gets one transaction. */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_WAIT_MS = 10_000;

export async function syncBootstrap(
  prisma: PrismaClient,
  plan: BootstrapPlan,
  options?: { timeoutMs?: number; maxWaitMs?: number },
): Promise<BootstrapSyncResult> {
  return prisma.$transaction(
    async (tx) => runSync(tx, plan),
    {
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxWait: options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    },
  );
}

async function runSync(
  tx: Prisma.TransactionClient,
  plan: BootstrapPlan,
): Promise<BootstrapSyncResult> {
  // ------------------------------------------------------------------ season
  // Keyed on startYear, not name: the year is the fact, the name is a rendering.
  const existingSeason = await tx.season.findUnique({ where: { startYear: plan.season.startYear } });
  const season =
    existingSeason ??
    (await tx.season.create({
      data: { name: plan.season.name, startYear: plan.season.startYear },
    }));
  if (existingSeason && existingSeason.name !== plan.season.name) {
    await tx.season.update({ where: { id: season.id }, data: { name: plan.season.name } });
  }

  // ------------------------------------------------------------------- clubs
  const clubs = await applyDiff({
    planned: plan.clubs,
    existing: await tx.club.findMany(),
    keyOfPlanned: (club) => String(club.identity.fplCode),
    keyOfExisting: (row) => String(row.fplCode),
    dataOf: (club) => club.identity satisfies Prisma.ClubCreateManyInput,
    createMany: (rows) => tx.club.createMany({ data: rows }),
    update: (id, data) => tx.club.update({ where: { id }, data }),
  });

  const clubIdByCode = new Map(
    (await tx.club.findMany({ select: { id: true, fplCode: true } })).map((c) => [c.fplCode, c.id]),
  );

  // ------------------------------------------------------------ club seasons
  const clubSeasons = await applyDiff({
    planned: plan.clubs,
    existing: await tx.clubSeason.findMany({ where: { seasonId: season.id } }),
    keyOfPlanned: (club) => String(clubIdByCode.get(club.identity.fplCode)),
    keyOfExisting: (row) => String(row.clubId),
    dataOf: (club) => ({
      seasonId: season.id,
      clubId: requireId(clubIdByCode.get(club.identity.fplCode), `club ${club.identity.fplCode}`),
      ...club.season,
    }),
    createMany: (rows) => tx.clubSeason.createMany({ data: rows }),
    update: (id, data) => tx.clubSeason.update({ where: { id }, data }),
  });

  const clubSeasonIdByClubId = new Map(
    (
      await tx.clubSeason.findMany({
        where: { seasonId: season.id },
        select: { id: true, clubId: true },
      })
    ).map((cs) => [cs.clubId, cs.id]),
  );

  // ----------------------------------------------------------------- players
  const players = await applyDiff({
    planned: plan.players,
    existing: await tx.fplPlayer.findMany(),
    keyOfPlanned: (player) => String(player.identity.fplCode),
    keyOfExisting: (row) => String(row.fplCode),
    dataOf: (player) => player.identity satisfies Prisma.FplPlayerCreateManyInput,
    createMany: (rows) => tx.fplPlayer.createMany({ data: rows }),
    update: (id, data) => tx.fplPlayer.update({ where: { id }, data }),
  });

  const playerIdByCode = new Map(
    (await tx.fplPlayer.findMany({ select: { id: true, fplCode: true } })).map((p) => [
      p.fplCode,
      p.id,
    ]),
  );

  // ---------------------------------------------------------- player seasons
  const playerSeasons = await applyDiff({
    planned: plan.players,
    existing: await tx.playerSeason.findMany({ where: { seasonId: season.id } }),
    keyOfPlanned: (player) => String(playerIdByCode.get(player.identity.fplCode)),
    keyOfExisting: (row) => String(row.playerId),
    dataOf: (player) => {
      const clubId = requireId(
        clubIdByCode.get(player.clubFplCode),
        `club ${player.clubFplCode}`,
      );
      return {
        seasonId: season.id,
        playerId: requireId(
          playerIdByCode.get(player.identity.fplCode),
          `player ${player.identity.fplCode}`,
        ),
        clubSeasonId: requireId(clubSeasonIdByClubId.get(clubId), `club season for club ${clubId}`),
        ...player.season,
      } satisfies Prisma.PlayerSeasonCreateManyInput;
    },
    createMany: (rows) => tx.playerSeason.createMany({ data: rows }),
    update: (id, data) => tx.playerSeason.update({ where: { id }, data }),
  });

  // --------------------------------------------------------------- gameweeks
  const gameweeks = await applyDiff({
    planned: plan.gameweeks,
    existing: await tx.gameweek.findMany({ where: { seasonId: season.id } }),
    keyOfPlanned: (gameweek) => String(gameweek.number),
    keyOfExisting: (row) => String(row.number),
    dataOf: (gameweek) => ({ seasonId: season.id, ...gameweek }),
    createMany: (rows) => tx.gameweek.createMany({ data: rows }),
    update: (id, data) => tx.gameweek.update({ where: { id }, data }),
  });

  return {
    season: {
      id: season.id,
      name: plan.season.name,
      startYear: plan.season.startYear,
      created: existingSeason === null,
    },
    clubs,
    clubSeasons,
    players,
    playerSeasons,
    gameweeks,
    warnings: plan.warnings,
  };
}

/**
 * A missing id here means a row we just wrote isn't there, which is a bug in
 * this file rather than in the payload. Fail rather than write a null FK.
 */
function requireId(id: number | undefined, what: string): number {
  if (id === undefined) throw new Error(`bootstrap sync: no database id for ${what}`);
  return id;
}
