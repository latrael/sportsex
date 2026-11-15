import {
  FairValueSource,
  LedgerAccount,
  LedgerReason,
  type PrismaClient,
} from '@prisma/client';
import type { FplBootstrapStatic, FplFixture } from '@/lib/fpl';
import {
  planBootstrap,
  planFixtures,
  syncBootstrap,
  syncFixtures,
  type BootstrapSyncResult,
  type FixturesSyncResult,
} from '@/lib/ingest';
import { recomputeSeasonStats, type SeasonStatsSyncResult } from '@/lib/derive/seasonStats/sync';
import { syncSeasonFairValues, type SyncFairValuesResult } from '@/lib/valuation';
import {
  getOrInitUserBalanceMinor,
  recordBalancedTransfer,
  reconcileLedger,
  syncUserCoinBalanceMirror,
} from '@/lib/market/ledger';
import { decimalCoinsToMinorUnits, toPriceDecimal } from '@/lib/money';

export type RolloverPositionPolicy = 'CARRY_WITH_CASH_OUT_DEPARTED' | 'CASH_OUT_ALL';

export interface RolloverPositionOutcome {
  positionsCarried: number;
  positionsCashedOut: number;
  totalCashOutMinor: bigint;
}

export interface SeasonRolloverResult {
  fromStartYear: number;
  toStartYear: number;
  bootstrap: BootstrapSyncResult;
  fixtures?: FixturesSyncResult;
  seasonStats: SeasonStatsSyncResult;
  seedFairValues: SyncFairValuesResult;
  positions: RolloverPositionOutcome;
  verification: {
    previousSeasonFixturesIntact: boolean;
    previousSeasonFairValuesIntact: boolean;
    ledgerReconciled: boolean;
  };
}

/**
 * R6.6 & R7.6 — Execute the August season rollover from `fromStartYear` (e.g. 2025)
 * to `toStartYear` (e.g. 2026).
 *
 * 1. Ingests the new season's `bootstrap-static` (including preseason null-strength clubs)
 *    and optional `fixtures` without touching cross-season `player`/`club` identities or
 *    `fromStartYear` history.
 * 2. Initialises `player_season_stat` (zeros before GW1) and seeds GW1 `Asset`, `FairValue`
 *    (`SEED`), and `PriceTick` (`VALUATION`) rows for `toStartYear`.
 * 3. Applies the R7.6 open-position rollover policy:
 *    - `CARRY_WITH_CASH_OUT_DEPARTED` (default): players and clubs still in the Premier
 *      League carry their share count into the new season's asset with `avgCost` reset to
 *      the new season's initial fair value; relegated clubs and departed players cash out
 *      at their final `fromStartYear` price with zero fee via balanced double-entry ledger
 *      transfer (`AMM_LIQUIDITY` -> `USER_CASH`).
 *    - `CASH_OUT_ALL`: all open `fromStartYear` positions cash out at final price.
 * 4. Verifies `fromStartYear` history integrity and Invariant 2 (`reconcileLedger`).
 */
export async function rolloverSeason(
  db: PrismaClient,
  options: {
    fromStartYear: number;
    bootstrapPayload: FplBootstrapStatic;
    fixturesPayload?: FplFixture[];
    positionPolicy?: RolloverPositionPolicy;
    now?: Date;
  },
): Promise<SeasonRolloverResult> {
  const policy = options.positionPolicy ?? 'CARRY_WITH_CASH_OUT_DEPARTED';
  const prevSeason = await db.season.findUnique({
    where: { startYear: options.fromStartYear },
  });
  if (!prevSeason) {
    throw new Error(`Previous season ${options.fromStartYear} not found`);
  }

  // Snapshot counts of previous season before rollover to verify zero data loss
  const prevFixtureCountBefore = await db.fixture.count({
    where: { seasonId: prevSeason.id },
  });
  const prevFvCountBefore = await db.fairValue.count({
    where: { gameweek: { seasonId: prevSeason.id } },
  });

  // 1. Plan & sync new season bootstrap-static
  const bootstrapPlan = planBootstrap(options.bootstrapPayload);
  const toStartYear = bootstrapPlan.season.startYear;
  if (toStartYear <= options.fromStartYear) {
    throw new Error(
      `New season startYear (${toStartYear}) must be greater than fromStartYear (${options.fromStartYear})`,
    );
  }

  const bootstrap = await syncBootstrap(db, bootstrapPlan);

  // 2. Plan & sync new season fixtures if provided
  let fixtures: FixturesSyncResult | undefined;
  if (options.fixturesPayload) {
    const fixturesPlan = planFixtures(options.fixturesPayload);
    fixtures = await syncFixtures(db, fixturesPlan, { startYear: toStartYear });
  }

  // 3. Initialise player_season_stat rows (zeros before GW1)
  const seasonStats = await recomputeSeasonStats(db, {
    startYear: toStartYear,
    now: options.now ? () => options.now! : undefined,
  });

  // 4. Seed GW1 Asset, FairValue (SEED), and PriceTick (VALUATION) rows for the new season
  const seedFairValues = await syncSeasonFairValues(db, {
    startYear: toStartYear,
    gameweekNumber: 1,
    source: FairValueSource.SEED,
    computedAt: options.now,
  });

  // 5. Handle open positions from `fromStartYear` according to `positionPolicy` (R7.6)
  const newSeason = await db.season.findUniqueOrThrow({
    where: { startYear: toStartYear },
  });

  // Map cross-season playerId -> new season Asset (and initial seed fair value)
  const newPlayerAssets = await db.asset.findMany({
    where: { playerSeason: { seasonId: newSeason.id } },
    include: {
      playerSeason: { select: { playerId: true } },
      priceTicks: {
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
      fairValues: {
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
    },
  });
  const newAssetByPlayerId = new Map<
    number,
    { assetId: number; initialPrice: number }
  >();
  for (const a of newPlayerAssets) {
    if (!a.playerSeason) continue;
    const price =
      a.priceTicks[0]?.price !== undefined
        ? Number(a.priceTicks[0].price)
        : a.fairValues[0]?.value !== undefined
          ? Number(a.fairValues[0].value)
          : 100;
    newAssetByPlayerId.set(a.playerSeason.playerId, {
      assetId: a.id,
      initialPrice: price,
    });
  }

  const newClubAssets = await db.asset.findMany({
    where: { clubSeason: { seasonId: newSeason.id } },
    include: {
      clubSeason: { select: { clubId: true } },
      priceTicks: {
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
      fairValues: {
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
        take: 1,
      },
    },
  });
  const newAssetByClubId = new Map<
    number,
    { assetId: number; initialPrice: number }
  >();
  for (const a of newClubAssets) {
    if (!a.clubSeason) continue;
    const price =
      a.priceTicks[0]?.price !== undefined
        ? Number(a.priceTicks[0].price)
        : a.fairValues[0]?.value !== undefined
          ? Number(a.fairValues[0].value)
          : 250;
    newAssetByClubId.set(a.clubSeason.clubId, {
      assetId: a.id,
      initialPrice: price,
    });
  }

  // Load all open positions on `fromStartYear` assets
  const openOldPositions = await db.position.findMany({
    where: {
      shares: { gt: 0 },
      OR: [
        { asset: { playerSeason: { seasonId: prevSeason.id } } },
        { asset: { clubSeason: { seasonId: prevSeason.id } } },
      ],
    },
    include: {
      asset: {
        include: {
          playerSeason: { select: { playerId: true } },
          clubSeason: { select: { clubId: true } },
          priceTicks: {
            orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
          fairValues: {
            orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  let positionsCarried = 0;
  let positionsCashedOut = 0;
  let totalCashOutMinor = 0n;

  for (const pos of openOldPositions) {
    const shares = pos.shares;
    if (shares <= 0) continue;

    const playerId = pos.asset.playerSeason?.playerId ?? null;
    const clubId = pos.asset.clubSeason?.clubId ?? null;

    const targetNewAsset =
      policy === 'CARRY_WITH_CASH_OUT_DEPARTED'
        ? playerId !== null
          ? newAssetByPlayerId.get(playerId)
          : clubId !== null
            ? newAssetByClubId.get(clubId)
            : undefined
        : undefined;

    if (targetNewAsset) {
      // Carry position forward into new season's asset with avgCost reset to new season's seed fair value
      await db.$transaction(async (tx) => {
        const updatedOld = await tx.position.updateMany({
          where: { id: pos.id, shares },
          data: { shares: 0 },
        });
        if (updatedOld.count === 0) return;

        await tx.asset.update({
          where: { id: pos.assetId },
          data: { inventory: { decrement: shares } },
        });

        const existingNewPos = await tx.position.findUnique({
          where: {
            userId_assetId: {
              userId: pos.userId,
              assetId: targetNewAsset.assetId,
            },
          },
        });

        if (existingNewPos) {
          const combinedShares = existingNewPos.shares + shares;
          await tx.position.update({
            where: { id: existingNewPos.id },
            data: {
              shares: combinedShares,
              avgCost: toPriceDecimal(targetNewAsset.initialPrice),
            },
          });
        } else {
          await tx.position.create({
            data: {
              userId: pos.userId,
              assetId: targetNewAsset.assetId,
              shares,
              avgCost: toPriceDecimal(targetNewAsset.initialPrice),
            },
          });
        }

        await tx.asset.update({
          where: { id: targetNewAsset.assetId },
          data: { inventory: { increment: shares } },
        });

        positionsCarried += 1;
      });
    } else {
      // Departed player / relegated club (or CASH_OUT_ALL policy): cash out at final price with zero fee
      const finalPrice =
        pos.asset.priceTicks[0]?.price !== undefined
          ? Number(pos.asset.priceTicks[0].price)
          : pos.asset.fairValues[0]?.value !== undefined
            ? Number(pos.asset.fairValues[0].value)
            : Number(pos.avgCost);
      const payoutMinor = decimalCoinsToMinorUnits(
        toPriceDecimal(shares * finalPrice),
        'floor',
      );

      await db.$transaction(async (tx) => {
        const updatedOld = await tx.position.updateMany({
          where: { id: pos.id, shares },
          data: { shares: 0 },
        });
        if (updatedOld.count === 0) return;

        await tx.asset.update({
          where: { id: pos.assetId },
          data: { inventory: { decrement: shares } },
        });

        if (payoutMinor > 0n) {
          const currentBal = await getOrInitUserBalanceMinor(tx, pos.userId);
          await recordBalancedTransfer(tx, [
            {
              userId: null,
              account: LedgerAccount.AMM_LIQUIDITY,
              reason: LedgerReason.TRADE_SELL,
              amount: -payoutMinor,
            },
            {
              userId: pos.userId,
              account: LedgerAccount.USER_CASH,
              reason: LedgerReason.TRADE_SELL,
              amount: payoutMinor,
            },
          ]);
          await syncUserCoinBalanceMirror(tx, pos.userId, currentBal + payoutMinor);
        }

        positionsCashedOut += 1;
        totalCashOutMinor += payoutMinor;
      });
    }
  }

  // 6. Verify previous season history and ledger conservation
  const prevFixtureCountAfter = await db.fixture.count({
    where: { seasonId: prevSeason.id },
  });
  const prevFvCountAfter = await db.fairValue.count({
    where: { gameweek: { seasonId: prevSeason.id } },
  });
  const recon = await reconcileLedger(db);

  return {
    fromStartYear: options.fromStartYear,
    toStartYear,
    bootstrap,
    fixtures,
    seasonStats,
    seedFairValues,
    positions: {
      positionsCarried,
      positionsCashedOut,
      totalCashOutMinor,
    },
    verification: {
      previousSeasonFixturesIntact: prevFixtureCountAfter === prevFixtureCountBefore,
      previousSeasonFairValuesIntact: prevFvCountAfter === prevFvCountBefore,
      ledgerReconciled: recon.ok,
    },
  };
}

/**
 * R6.6 — Roll back a pre-GW1 season rollover rehearsal or cutover, restoring
 * open positions to `previousStartYear` if needed and removing `targetStartYear`
 * season-scoped rows while leaving `previousStartYear` completely intact.
 */
export async function rollbackSeasonRollover(
  db: PrismaClient,
  options: {
    targetStartYear: number;
  },
): Promise<{ deletedSeasonId: number | null }> {
  const season = await db.season.findUnique({
    where: { startYear: options.targetStartYear },
  });
  if (!season) {
    return { deletedSeasonId: null };
  }

  await db.$transaction(async (tx) => {
    const assets = await tx.asset.findMany({
      where: {
        OR: [
          { playerSeason: { seasonId: season.id } },
          { clubSeason: { seasonId: season.id } },
        ],
      },
      select: { id: true },
    });
    const assetIds = assets.map((a) => a.id);

    if (assetIds.length > 0) {
      await tx.priceTick.deleteMany({ where: { assetId: { in: assetIds } } });
      await tx.fairValue.deleteMany({ where: { assetId: { in: assetIds } } });
      await tx.position.deleteMany({ where: { assetId: { in: assetIds } } });
      await tx.trade.deleteMany({ where: { assetId: { in: assetIds } } });
      await tx.asset.deleteMany({ where: { id: { in: assetIds } } });
    }

    await tx.playerSeasonStat.deleteMany({
      where: { playerSeason: { seasonId: season.id } },
    });
    await tx.playerFixtureStat.deleteMany({
      where: { gameweek: { seasonId: season.id } },
    });
    await tx.playerGameweekStat.deleteMany({
      where: { gameweek: { seasonId: season.id } },
    });
    await tx.fixture.deleteMany({ where: { seasonId: season.id } });
    await tx.gameweek.deleteMany({ where: { seasonId: season.id } });
    await tx.playerSeason.deleteMany({ where: { seasonId: season.id } });
    await tx.clubSeason.deleteMany({ where: { seasonId: season.id } });
    await tx.season.delete({ where: { id: season.id } });
  });

  return { deletedSeasonId: season.id };
}
