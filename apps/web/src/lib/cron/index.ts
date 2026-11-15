import {
  FairValueSource,
  LedgerReason,
  type PrismaClient,
} from '@prisma/client';
import { FplClient } from '@/lib/fpl';
import {
  planBootstrap,
  planEventLive,
  planFixtures,
  syncBootstrap,
  syncEventLive,
  syncFixtures,
  type BootstrapSyncResult,
  type EventLiveSyncResult,
  type FixturesSyncResult,
  type RawPayloadOutcome,
} from '@/lib/ingest';
import { archiveRawPayload } from '@/lib/ingest/rawPayload';
import { recomputeSeasonStats, type SeasonStatsSyncResult } from '@/lib/derive/seasonStats/sync';
import { syncSeasonFairValues, type SyncFairValuesResult } from '@/lib/valuation';
import { mintToUser } from '@/lib/market/ledger';
import { coinsToMinorUnits } from '@/lib/money';

export interface BootstrapCronResult {
  sync: BootstrapSyncResult;
  raw: RawPayloadOutcome;
  seasonStats: SeasonStatsSyncResult;
  reprice?: SyncFairValuesResult;
}

/**
 * R6.1 — Daily `bootstrap-static` cron for prices, availability, and squad changes.
 *
 * Fetches `bootstrap-static`, archives the raw payload, syncs reference tables,
 * ensures `player_season_stat` covers any new squad arrivals, and triggers an
 * `AVAILABILITY` fair-value/price-tick update when player status or availability changes.
 */
export async function runBootstrapCron(
  db: PrismaClient,
  options: {
    client?: FplClient;
    now?: Date;
    forceReprice?: boolean;
  } = {},
): Promise<BootstrapCronResult> {
  const client = options.client ?? new FplClient();
  const { data, raw } = await client.bootstrapStatic();
  const plan = planBootstrap(data);
  const sync = await syncBootstrap(db, plan);
  const rawOutcome = await archiveRawPayload(db, raw, `${plan.season.startYear}:bootstrap`);

  // Ensure every playerSeason has a playerSeasonStat row
  const seasonStats = await recomputeSeasonStats(db, {
    startYear: plan.season.startYear,
    now: options.now ? () => options.now! : undefined,
  });

  const hasSquadOrAvailabilityChanges =
    options.forceReprice === true ||
    sync.playerSeasons.created > 0 ||
    sync.playerSeasons.updated > 0 ||
    sync.clubSeasons.created > 0 ||
    sync.clubSeasons.updated > 0;

  let reprice: SyncFairValuesResult | undefined;
  if (hasSquadOrAvailabilityChanges) {
    // Find current/latest active gameweek in this season
    const season = await db.season.findUnique({ where: { startYear: plan.season.startYear } });
    if (season) {
      const gws = await db.gameweek.findMany({
        where: { seasonId: season.id },
        orderBy: { number: 'asc' },
      });
      const activeGw =
        gws.find((g) => g.isCurrent) ??
        [...gws].reverse().find((g) => g.finished || g.dataChecked) ??
        gws[0];
      if (activeGw) {
        reprice = await syncSeasonFairValues(db, {
          startYear: plan.season.startYear,
          gameweekNumber: activeGw.number,
          source: FairValueSource.AVAILABILITY,
          computedAt: options.now,
        });
      }
    }
  }

  return {
    sync,
    raw: rawOutcome,
    seasonStats,
    reprice,
  };
}

export interface FixturesCronResult {
  sync: FixturesSyncResult;
  raw: RawPayloadOutcome;
}

/**
 * R6.2 — Hourly `fixtures` cron.
 */
export async function runFixturesCron(
  db: PrismaClient,
  options: {
    client?: FplClient;
    startYear?: number;
  } = {},
): Promise<FixturesCronResult> {
  const startYear =
    options.startYear ??
    (
      await db.season.findFirst({
        orderBy: { startYear: 'desc' },
        select: { startYear: true },
      })
    )?.startYear;

  if (!startYear) {
    throw new Error('No season in database — run bootstrap-static cron first');
  }

  const client = options.client ?? new FplClient();
  const { data, raw } = await client.fixtures();
  const plan = planFixtures(data);
  const sync = await syncFixtures(db, plan, { startYear });
  const rawOutcome = await archiveRawPayload(db, raw, `${startYear}:fixtures`);

  return {
    sync,
    raw: rawOutcome,
  };
}

const PRE_KICKOFF_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before kickoff
const POST_KICKOFF_FINISHED_WINDOW_MS = 150 * 60 * 1000; // 2.5 hours after kickoff if marked finished
const POST_KICKOFF_UNFINISHED_MAX_MS = 240 * 60 * 1000; // 4 hours max window if not yet marked finished

/**
 * R6.3 — Determine which gameweek numbers in `startYear` have fixtures inside an
 * active match window at `now`.
 */
export async function getActiveMatchWindowGameweeks(
  db: PrismaClient,
  options: {
    startYear?: number;
    now?: Date;
  } = {},
): Promise<{ startYear: number; gameweekNumbers: number[] }> {
  const now = options.now ?? new Date();
  const season = options.startYear
    ? await db.season.findUnique({ where: { startYear: options.startYear } })
    : await db.season.findFirst({ orderBy: { startYear: 'desc' } });

  if (!season) {
    return { startYear: options.startYear ?? 0, gameweekNumbers: [] };
  }

  const fixtures = await db.fixture.findMany({
    where: {
      seasonId: season.id,
      gameweekId: { not: null },
      kickoffTime: { not: null },
    },
    include: {
      gameweek: { select: { number: true } },
    },
  });

  const nowMs = now.getTime();
  const activeGws = new Set<number>();

  for (const f of fixtures) {
    if (!f.kickoffTime || !f.gameweek) continue;
    const koMs = f.kickoffTime.getTime();
    const elapsedMs = nowMs - koMs;

    // Not yet within 5 minutes of kickoff
    if (elapsedMs < -PRE_KICKOFF_BUFFER_MS) continue;

    // Inside live window: either not finished within 4h of kickoff, or within 2.5h of kickoff
    const inWindow =
      (!f.finished && elapsedMs <= POST_KICKOFF_UNFINISHED_MAX_MS) ||
      elapsedMs <= POST_KICKOFF_FINISHED_WINDOW_MS;

    if (inWindow) {
      activeGws.add(f.gameweek.number);
    }
  }

  return {
    startYear: season.startYear,
    gameweekNumbers: [...activeGws].sort((a, b) => a - b),
  };
}

export interface LiveCronResult {
  skipped: boolean;
  reason?: 'outside_match_window';
  startYear: number;
  gameweeksPolled: number[];
  results: EventLiveSyncResult[];
}

/**
 * R6.3 — Poll `event/{gw}/live` every 2 minutes inside match windows only.
 * Outside match windows, returns immediately without calling FPL.
 */
export async function runLiveCron(
  db: PrismaClient,
  options: {
    client?: FplClient;
    startYear?: number;
    now?: Date;
  } = {},
): Promise<LiveCronResult> {
  const { startYear, gameweekNumbers } = await getActiveMatchWindowGameweeks(db, {
    startYear: options.startYear,
    now: options.now,
  });

  if (gameweekNumbers.length === 0) {
    return {
      skipped: true,
      reason: 'outside_match_window',
      startYear,
      gameweeksPolled: [],
      results: [],
    };
  }

  const client = options.client ?? new FplClient();
  const results: EventLiveSyncResult[] = [];

  for (const gwNum of gameweekNumbers) {
    const { data, raw } = await client.eventLive(gwNum);
    const plan = planEventLive(data);
    const sync = await syncEventLive(db, plan, {
      startYear,
      gameweekNumber: gwNum,
      raw,
    });
    results.push(sync);
  }

  return {
    skipped: false,
    startYear,
    gameweeksPolled: gameweekNumbers,
    results,
  };
}

export interface PredictionSettlementSummary {
  predictionsResolved: number;
  predictionsWon: number;
  totalPayoutCoins: number;
}

export interface GameweekSettlementResult {
  season: { id: number; startYear: number };
  gameweek: { id: number; number: number; alreadySettled: boolean; settledAt: Date };
  liveSync?: EventLiveSyncResult;
  seasonStats: SeasonStatsSyncResult;
  fairValues: SyncFairValuesResult;
  predictions: PredictionSettlementSummary;
}

/**
 * R6.4 — Settle a single gameweek when `dataChecked === true` (or on explicit request).
 *
 * Strictly idempotent on `(player_id, fixture_id)` (Invariant 3):
 * - Re-syncing live event rows via `applyDiff` changes 0 rows when data is unchanged.
 * - Recomputing `player_season_stat` from immutable event rows changes 0 rows.
 * - Recomputing `fair_value` + `price_tick` changes 0 rows when valuations match.
 * - Resolving predictions uses an atomic `resolved: false -> true` update inside a
 *   transaction before minting `PREDICTION_PAYOUT` ledger entries, so re-settling
 *   never double-pays.
 */
export async function settleGameweek(
  db: PrismaClient,
  options: {
    startYear: number;
    gameweekNumber: number;
    client?: FplClient;
    fetchLive?: boolean;
    now?: Date;
  },
): Promise<GameweekSettlementResult> {
  const now = options.now ?? new Date();
  const season = await db.season.findUnique({ where: { startYear: options.startYear } });
  if (!season) {
    throw new Error(`Season ${options.startYear} not found`);
  }

  const gameweek = await db.gameweek.findUnique({
    where: {
      seasonId_number: {
        seasonId: season.id,
        number: options.gameweekNumber,
      },
    },
  });
  if (!gameweek) {
    throw new Error(`Gameweek ${options.gameweekNumber} not found in season ${options.startYear}`);
  }

  const alreadySettled = gameweek.settledAt !== null;

  // 1. Optional live fetch to ensure final bonus/stats after data_checked: true
  let liveSync: EventLiveSyncResult | undefined;
  if (options.fetchLive && options.client) {
    const { data, raw } = await options.client.eventLive(options.gameweekNumber);
    const plan = planEventLive(data);
    liveSync = await syncEventLive(db, plan, {
      startYear: options.startYear,
      gameweekNumber: options.gameweekNumber,
      raw,
    });
  }

  // 2. Recompute derived season aggregates from immutable event rows (R2.3)
  const seasonStats = await recomputeSeasonStats(db, {
    startYear: options.startYear,
    now: () => now,
  });

  // 3. Recompute Layer 1 fair values and valuation price ticks for this gameweek (R3.5)
  const fairValues = await syncSeasonFairValues(db, {
    startYear: options.startYear,
    gameweekNumber: options.gameweekNumber,
    source: FairValueSource.GAMEWEEK,
  });

  // 4. Resolve predictions for finished fixtures in this gameweek
  const unresolvedPredictions = await db.prediction.findMany({
    where: {
      resolved: false,
      fixture: {
        gameweekId: gameweek.id,
        finished: true,
        homeScore: { not: null },
        awayScore: { not: null },
      },
    },
    include: {
      fixture: {
        select: {
          id: true,
          homeScore: true,
          awayScore: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  let predictionsResolved = 0;
  let predictionsWon = 0;
  let totalPayoutCoins = 0;

  for (const pred of unresolvedPredictions) {
    const homeScore = pred.fixture.homeScore!;
    const awayScore = pred.fixture.awayScore!;
    const outcome = homeScore > awayScore ? 'H' : awayScore > homeScore ? 'A' : 'D';
    const won = pred.pick === outcome;
    const oddsNum = Number(pred.odds ?? 2);
    const payout = won ? Math.round(pred.coinsStaked * oddsNum) : 0;

    await db.$transaction(async (tx) => {
      // Atomic guard: only resolve if still unresolved inside transaction
      const updated = await tx.prediction.updateMany({
        where: { id: pred.id, resolved: false },
        data: {
          resolved: true,
          payout,
        },
      });
      if (updated.count === 0) return;

      predictionsResolved += 1;
      if (won && payout > 0) {
        predictionsWon += 1;
        totalPayoutCoins += payout;
        await mintToUser(tx, {
          userId: pred.userId,
          amountMinor: coinsToMinorUnits(payout),
          reason: LedgerReason.PREDICTION_PAYOUT,
        });
      }
    });
  }

  // 5. Stamp settledAt if not already stamped
  const settledAt = gameweek.settledAt ?? now;
  if (!gameweek.settledAt) {
    await db.gameweek.update({
      where: { id: gameweek.id },
      data: { settledAt },
    });
  }

  return {
    season: { id: season.id, startYear: season.startYear },
    gameweek: {
      id: gameweek.id,
      number: gameweek.number,
      alreadySettled,
      settledAt,
    },
    liveSync,
    seasonStats,
    fairValues,
    predictions: {
      predictionsResolved,
      predictionsWon,
      totalPayoutCoins,
    },
  };
}

/**
 * R6.4 — Cron entrypoint that settles all gameweeks where `dataChecked === true`
 * and `settledAt === null` (or re-settles a specified `gameweekNumber`).
 */
export async function runSettleCron(
  db: PrismaClient,
  options: {
    startYear?: number;
    gameweekNumber?: number;
    client?: FplClient;
    fetchLive?: boolean;
    now?: Date;
  } = {},
): Promise<{ settled: GameweekSettlementResult[] }> {
  const season = options.startYear
    ? await db.season.findUnique({ where: { startYear: options.startYear } })
    : await db.season.findFirst({ orderBy: { startYear: 'desc' } });

  if (!season) {
    return { settled: [] };
  }

  const targetGameweeks =
    options.gameweekNumber !== undefined
      ? await db.gameweek.findMany({
          where: { seasonId: season.id, number: options.gameweekNumber },
        })
      : await db.gameweek.findMany({
          where: {
            seasonId: season.id,
            dataChecked: true,
            settledAt: null,
          },
          orderBy: { number: 'asc' },
        });

  const settled: GameweekSettlementResult[] = [];
  for (const gw of targetGameweeks) {
    const res = await settleGameweek(db, {
      startYear: season.startYear,
      gameweekNumber: gw.number,
      client: options.client,
      fetchLive: options.fetchLive,
      now: options.now,
    });
    settled.push(res);
  }

  return { settled };
}
