/**
 * R4.3 — Single-transaction AMM trade execution engine.
 *
 * Executes a BUY or SELL order against the bonding curve `P(q) = V·exp((q−q₀)/L)`
 * inside one Postgres transaction with row-level `FOR UPDATE` locking on the user
 * and asset. Execution and price formation are a single computation:
 *   - Quotes the exact curve integral + fee (`quoteTrade`)
 *   - Verifies ledger balance (`getOrInitUserBalanceMinor`) and share holdings
 *   - Updates `asset.inventory` (`q → q ± n`)
 *   - Upserts/deletes `position`
 *   - Writes `trade`
 *   - Writes `price_tick` (`source = TRADE`, `tradeId = trade.id`)
 *   - Writes balanced `ledger_entry` rows (`USER_CASH`, `AMM_LIQUIDITY`, `FEE_SINK`)
 *   - Mirrors legacy v1 tables (`user.coinBalance`, `holding`, `transaction`, `valuation`)
 *     when a matching v1 asset exists so existing v1 tests & pages remain green until R5.7.
 */

import {
  AssetKind,
  FairValueSource,
  LedgerAccount,
  LedgerReason,
  PlayerPosition,
  PriceTickSource,
  Prisma,
  TradeSide,
  type PrismaClient,
} from '@prisma/client';
import {
  MINOR_UNITS_PER_COIN,
  minorUnitsToCoinsDecimal,
  toPriceDecimal,
  type MinorUnits,
} from '@/lib/money';
import {
  DEFAULT_FEE_BPS,
  DEFAULT_FLOAT_SHARES,
  quoteTrade,
  seedLiquidityForFloat,
  type TradeQuote,
} from './curve';
import {
  getOrInitUserBalanceMinor,
  recordBalancedTransfer,
  syncUserCoinBalanceMirror,
} from './ledger';

export const MAX_FLOAT_PCT_PER_ORDER = 0.05;
export const MAX_POSITION_SHARES = 2000;

export interface ExecuteAmmOrderInput {
  userId: string;
  /** Either pass `v2AssetId` directly or `(assetKind, assetId)` which resolves or bridges to `Asset`. */
  v2AssetId?: number;
  assetKind?: 'player' | 'team';
  assetId?: number;
  side: 'buy' | 'sell' | 'BUY' | 'SELL';
  shares: number;
  feeBps?: bigint;
  /** Enforce 5% float cap per order (default true; can be disabled in §2 1000-share exploit regression test). */
  enforceMaxFloatPct?: boolean;
}

export interface ExecuteAmmOrderResult {
  tradeId: number;
  assetId: number;
  quote: TradeQuote;
  /** Average fill price in coins. */
  price: number;
  /** Spot price after the fill in coins. */
  spotPriceAfter: number;
  /** Signed cash delta in minor units (`bigint`). */
  coinsDeltaMinor: MinorUnits;
  /** Signed cash delta in whole coins (rounded for v1 API compatibility). */
  coinsDelta: number;
  /** User's updated balance in minor units (`bigint`). */
  balanceAfterMinor: MinorUnits;
  /** User's updated balance in whole coins. */
  balanceAfterCoins: number;
}

/**
 * Resolve or lazily provision a v2 `Asset` + initial `FairValue` for a request that
 * specifies `(assetKind, assetId)` (where `assetId` may be a v2 `Asset.id`,
 * `player_season.id`, `club_season.id`, or a legacy v1 `Player.id` / `Team.id` from
 * test helpers).
 */
async function resolveOrBridgeAsset(
  tx: Prisma.TransactionClient,
  input: ExecuteAmmOrderInput,
): Promise<{
  asset: {
    id: number;
    kind: AssetKind;
    playerSeasonId: number | null;
    clubSeasonId: number | null;
    inventory: number;
    seedInventory: number;
    liquidity: Prisma.Decimal;
  };
  fairValue: Prisma.Decimal;
  floatShares: number;
  v1PlayerId: number | null;
  v1TeamId: number | null;
}> {
  if (input.v2AssetId !== undefined) {
    const asset = await tx.asset.findUnique({ where: { id: input.v2AssetId } });
    if (!asset) throw new Error('no_asset');
    const latestFv = await tx.fairValue.findFirst({
      where: { assetId: asset.id },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    });
    if (!latestFv) throw new Error('no_price');
    return {
      asset,
      fairValue: latestFv.value,
      floatShares: DEFAULT_FLOAT_SHARES,
      v1PlayerId: null,
      v1TeamId: null,
    };
  }

  const kind = input.assetKind ?? 'player';
  const targetId = input.assetId!;

  // 1. Check if a v2 Asset with this id or playerSeasonId/clubSeasonId already exists
  const directAsset = await tx.asset.findFirst({
    where:
      kind === 'player'
        ? { OR: [{ id: targetId, kind: AssetKind.PLAYER }, { playerSeasonId: targetId }] }
        : { OR: [{ id: targetId, kind: AssetKind.CLUB }, { clubSeasonId: targetId }] },
  });

  if (directAsset) {
    const latestFv = await tx.fairValue.findFirst({
      where: { assetId: directAsset.id },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    });
    if (latestFv) {
      // Check if there is also a v1 player/team with targetId for mirror updates
      const v1Player =
        kind === 'player' ? await tx.player.findUnique({ where: { id: targetId } }) : null;
      const v1Team =
        kind === 'team' ? await tx.team.findUnique({ where: { id: targetId } }) : null;
      return {
        asset: directAsset,
        fairValue: latestFv.value,
        floatShares: v1Player?.totalShares ?? (kind === 'team' ? 4000 : DEFAULT_FLOAT_SHARES),
        v1PlayerId: v1Player?.id ?? null,
        v1TeamId: v1Team?.id ?? null,
      };
    }
  }

  // 2. Bridge from v1 Player / Team (used by existing v1 integration tests & seed data)
  if (kind === 'player') {
    const v1Player = await tx.player.findUnique({ where: { id: targetId } });
    if (!v1Player) throw new Error('no_asset');
    const v1Val = await tx.valuation.findFirst({
      where: { playerId: v1Player.id },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    });
    if (!v1Val || !Number.isFinite(v1Val.price) || v1Val.price <= 0) {
      throw new Error('no_price');
    }

    // Ensure a bridge Season + Club + ClubSeason + FplPlayer + PlayerSeason + Asset exist
    const season = await tx.season.upsert({
      where: { startYear: 2025 },
      update: {},
      create: { name: '2025/26', startYear: 2025 },
    });
    const clubCode = 900_000 + (v1Player.teamId ?? 0);
    const club = await tx.club.upsert({
      where: { fplCode: clubCode },
      update: {},
      create: {
        fplCode: clubCode,
        name: `Club-${clubCode}`,
        shortName: 'CLB',
      },
    });
    const clubSeason = await tx.clubSeason.upsert({
      where: { seasonId_clubId: { seasonId: season.id, clubId: club.id } },
      update: {},
      create: {
        seasonId: season.id,
        clubId: club.id,
        fplId: clubCode,
      },
    });
    const playerCode = 800_000 + v1Player.id;
    const fplPlayer = await tx.fplPlayer.upsert({
      where: { fplCode: playerCode },
      update: {},
      create: {
        fplCode: playerCode,
        optaCode: `p${playerCode}`,
        firstName: v1Player.fullName.split(' ')[0] || v1Player.fullName,
        secondName: v1Player.fullName.split(' ').slice(1).join(' ') || v1Player.fullName,
        webName: v1Player.fullName,
      },
    });
    const ps = await tx.playerSeason.upsert({
      where: { seasonId_playerId: { seasonId: season.id, playerId: fplPlayer.id } },
      update: {},
      create: {
        seasonId: season.id,
        playerId: fplPlayer.id,
        clubSeasonId: clubSeason.id,
        fplId: playerCode,
        position: PlayerPosition.FWD,
        status: 'a',
        news: '',
        nowCost: 50,
        selectedByPercent: new Prisma.Decimal('0.000'),
      },
    });

    const { seedInventory, liquidityDecimal } = seedLiquidityForFloat(v1Player.totalShares);
    const asset = await tx.asset.upsert({
      where: { playerSeasonId: ps.id },
      update: {},
      create: {
        kind: AssetKind.PLAYER,
        playerSeasonId: ps.id,
        inventory: v1Player.sharesHeld,
        seedInventory,
        liquidity: liquidityDecimal,
      },
    });

    const fvDecimal = toPriceDecimal(v1Val.basePrice ?? v1Val.price);
    const existingFv = await tx.fairValue.findFirst({
      where: { assetId: asset.id },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    });
    if (!existingFv) {
      await tx.fairValue.create({
        data: {
          assetId: asset.id,
          source: FairValueSource.SEED,
          value: fvDecimal,
        },
      });
    }

    return {
      asset,
      fairValue: existingFv?.value ?? fvDecimal,
      floatShares: v1Player.totalShares,
      v1PlayerId: v1Player.id,
      v1TeamId: null,
    };
  } else {
    const v1Team = await tx.team.findUnique({ where: { id: targetId } });
    if (!v1Team) throw new Error('no_asset');
    const v1Val = await tx.valuation.findFirst({
      where: { teamId: v1Team.id },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    });
    if (!v1Val || !Number.isFinite(v1Val.price) || v1Val.price <= 0) {
      throw new Error('no_price');
    }

    const season = await tx.season.upsert({
      where: { startYear: 2025 },
      update: {},
      create: { name: '2025/26', startYear: 2025 },
    });
    const clubCode = 700_000 + v1Team.id;
    const club = await tx.club.upsert({
      where: { fplCode: clubCode },
      update: {},
      create: {
        fplCode: clubCode,
        name: v1Team.name,
        shortName: v1Team.shortName ?? v1Team.name.slice(0, 3).toUpperCase(),
      },
    });
    const cs = await tx.clubSeason.upsert({
      where: { seasonId_clubId: { seasonId: season.id, clubId: club.id } },
      update: {},
      create: {
        seasonId: season.id,
        clubId: club.id,
        fplId: clubCode,
      },
    });

    const { seedInventory, liquidityDecimal } = seedLiquidityForFloat(4000);
    const asset = await tx.asset.upsert({
      where: { clubSeasonId: cs.id },
      update: {},
      create: {
        kind: AssetKind.CLUB,
        clubSeasonId: cs.id,
        inventory: 0,
        seedInventory,
        liquidity: liquidityDecimal,
      },
    });

    const fvDecimal = toPriceDecimal(v1Val.basePrice ?? v1Val.price);
    const existingFv = await tx.fairValue.findFirst({
      where: { assetId: asset.id },
      orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    });
    if (!existingFv) {
      await tx.fairValue.create({
        data: {
          assetId: asset.id,
          source: FairValueSource.SEED,
          value: fvDecimal,
        },
      });
    }

    return {
      asset,
      fairValue: existingFv?.value ?? fvDecimal,
      floatShares: 4000, // 5% of 4000 = 200 shares max per order for teams
      v1PlayerId: null,
      v1TeamId: v1Team.id,
    };
  }
}

/**
 * Execute an AMM order atomically inside a single database transaction with
 * row-level locking (`SELECT ... FOR UPDATE`) on the user and asset rows.
 */
export async function executeAmmOrder(
  db: PrismaClient,
  input: ExecuteAmmOrderInput,
): Promise<ExecuteAmmOrderResult> {
  const normSide = input.side.toUpperCase() as 'BUY' | 'SELL';
  const shares = input.shares;
  if (!Number.isInteger(shares) || shares <= 0) {
    throw new Error('bad_request');
  }

  return db.$transaction(async (tx) => {
    // 1. Acquire row-level lock on User to serialize concurrent orders from the same user
    const lockedUsers = await tx.$queryRaw<{ id: string; coinBalance: number }[]>`
      SELECT id, "coinBalance" FROM "User" WHERE id = ${input.userId} FOR UPDATE
    `;
    if (lockedUsers.length === 0) {
      throw new Error('no_user');
    }

    // 2. Resolve or bridge the target Asset and lock it FOR UPDATE
    const resolved = await resolveOrBridgeAsset(tx, input);
    const lockedAssets = await tx.$queryRaw<
      { id: number; inventory: number; seedInventory: number; liquidity: Prisma.Decimal }[]
    >`
      SELECT id, inventory, "seedInventory", liquidity
      FROM asset
      WHERE id = ${resolved.asset.id}
      FOR UPDATE
    `;
    const lockedAsset = lockedAssets[0];
    if (!lockedAsset) {
      throw new Error('no_asset');
    }

    // 3. Enforce float & per-order size guards on BUY
    const enforceCap = input.enforceMaxFloatPct ?? true;
    const maxOrderShares = Math.ceil(resolved.floatShares * MAX_FLOAT_PCT_PER_ORDER);
    if (normSide === 'BUY') {
      if (lockedAsset.inventory + shares > resolved.floatShares) {
        throw new Error('insufficient_float');
      }
      if (enforceCap && shares > maxOrderShares) {
        throw new Error('max_float_pct');
      }
    }

    // 4. Quote exact bonding curve execution & new price in one step
    const quote = quoteTrade(
      {
        fairValue: resolved.fairValue,
        inventory: lockedAsset.inventory,
        seedInventory: lockedAsset.seedInventory,
        liquidity: lockedAsset.liquidity,
        feeBps: input.feeBps ?? DEFAULT_FEE_BPS,
      },
      normSide,
      shares,
    );

    // 5. Check user cash balance from double-entry ledger (Invariant 5)
    const balanceBeforeMinor = await getOrInitUserBalanceMinor(
      tx,
      input.userId,
      lockedUsers[0].coinBalance,
    );

    if (normSide === 'BUY' && balanceBeforeMinor < quote.totalUserCashMinor) {
      throw new Error('insufficient_funds');
    }

    // 6. Check and update user Position (v2) + Holding (v1 mirror if applicable)
    let existingPos = await tx.position.findUnique({
      where: { userId_assetId: { userId: input.userId, assetId: lockedAsset.id } },
    });

    // Bridge v1 holding if a test seeded `db.holding.create` directly before calling sell
    const legacyKind = input.assetKind ?? (resolved.asset.kind === AssetKind.PLAYER ? 'player' : 'team');
    const legacyAssetId = resolved.v1PlayerId ?? resolved.v1TeamId;
    const existingV1Holding =
      legacyAssetId != null
        ? await tx.holding.findFirst({
            where: { userId: input.userId, assetKind: legacyKind, assetId: legacyAssetId },
          })
        : null;

    if (!existingPos && existingV1Holding) {
      existingPos = await tx.position.create({
        data: {
          userId: input.userId,
          assetId: lockedAsset.id,
          shares: existingV1Holding.shares,
          avgCost: toPriceDecimal(existingV1Holding.avgCost),
        },
      });
    }

    if (normSide === 'SELL') {
      if (!existingPos || existingPos.shares < shares) {
        throw new Error('insufficient_shares');
      }
    }

    if (normSide === 'BUY') {
      const prevShares = existingPos?.shares ?? 0;
      const newShares = prevShares + shares;
      if (enforceCap && newShares > MAX_POSITION_SHARES) {
        throw new Error('position_cap');
      }
      const prevCostCoins = existingPos
        ? existingPos.avgCost.mul(new Prisma.Decimal(prevShares))
        : new Prisma.Decimal(0);
      const addedCostCoins = minorUnitsToCoinsDecimal(quote.totalUserCashMinor);
      const newAvgCost = toPriceDecimal(
        prevCostCoins.add(addedCostCoins).div(new Prisma.Decimal(newShares)),
      );

      if (existingPos) {
        await tx.position.update({
          where: { id: existingPos.id },
          data: { shares: newShares, avgCost: newAvgCost },
        });
      } else {
        await tx.position.create({
          data: {
            userId: input.userId,
            assetId: lockedAsset.id,
            shares: newShares,
            avgCost: newAvgCost,
          },
        });
      }

      if (legacyAssetId != null) {
        if (existingV1Holding) {
          await tx.holding.update({
            where: { id: existingV1Holding.id },
            data: { shares: newShares, avgCost: newAvgCost.toNumber() },
          });
        } else {
          await tx.holding.create({
            data: {
              userId: input.userId,
              assetKind: legacyKind,
              assetId: legacyAssetId,
              shares: newShares,
              avgCost: newAvgCost.toNumber(),
            },
          });
        }
      }
    } else {
      const newShares = existingPos!.shares - shares;
      if (newShares === 0) {
        await tx.position.delete({ where: { id: existingPos!.id } });
        if (existingV1Holding) {
          await tx.holding.delete({ where: { id: existingV1Holding.id } });
        }
      } else {
        await tx.position.update({
          where: { id: existingPos!.id },
          data: { shares: newShares },
        });
        if (existingV1Holding) {
          await tx.holding.update({
            where: { id: existingV1Holding.id },
            data: { shares: newShares },
          });
        }
      }
    }

    // 7. Update Asset inventory q -> qAfter
    await tx.asset.update({
      where: { id: lockedAsset.id },
      data: { inventory: quote.inventoryAfter },
    });

    if (resolved.v1PlayerId != null) {
      await tx.player.update({
        where: { id: resolved.v1PlayerId },
        data: { sharesHeld: Math.max(0, quote.inventoryAfter) },
      });
    }

    // 8. Record Trade row
    const trade = await tx.trade.create({
      data: {
        userId: input.userId,
        assetId: lockedAsset.id,
        side: normSide === 'BUY' ? TradeSide.BUY : TradeSide.SELL,
        shares,
        avgPrice: quote.decimals.avgPrice,
        grossCost: quote.grossCostMinor,
        fee: quote.feeMinor,
        inventoryAfter: quote.inventoryAfter,
      },
    });

    // 9. Record PriceTick row (TRADE) in the same transaction
    await tx.priceTick.create({
      data: {
        assetId: lockedAsset.id,
        source: PriceTickSource.TRADE,
        tradeId: trade.id,
        price: quote.decimals.spotPriceAfter,
        fairValue: quote.decimals.fairValue,
        inventory: quote.inventoryAfter,
      },
    });

    if (resolved.v1PlayerId != null) {
      await tx.valuation.create({
        data: {
          playerId: resolved.v1PlayerId,
          price: quote.spotPriceAfter,
          basePrice: Number(resolved.fairValue),
          demandMult: quote.spotPriceAfter / Number(resolved.fairValue),
        },
      });
    } else if (resolved.v1TeamId != null) {
      await tx.valuation.create({
        data: {
          teamId: resolved.v1TeamId,
          price: quote.spotPriceAfter,
          basePrice: Number(resolved.fairValue),
          demandMult: quote.spotPriceAfter / Number(resolved.fairValue),
        },
      });
    }

    // 10. Record balanced double-entry LedgerEntry legs (Invariant 2)
    //   BUY:
    //     USER_CASH     -(gross + fee)
    //     AMM_LIQUIDITY +gross
    //     FEE_SINK      +fee
    //   SELL:
    //     AMM_LIQUIDITY -gross
    //     USER_CASH     +(gross - fee)
    //     FEE_SINK      +fee
    if (normSide === 'BUY') {
      await recordBalancedTransfer(tx, [
        {
          userId: input.userId,
          account: LedgerAccount.USER_CASH,
          reason: LedgerReason.TRADE_BUY,
          amount: -quote.totalUserCashMinor,
          tradeId: trade.id,
        },
        {
          userId: null,
          account: LedgerAccount.AMM_LIQUIDITY,
          reason: LedgerReason.TRADE_BUY,
          amount: quote.grossCostMinor,
          tradeId: trade.id,
        },
        ...(quote.feeMinor > 0n
          ? [
              {
                userId: null,
                account: LedgerAccount.FEE_SINK,
                reason: LedgerReason.TRADE_FEE,
                amount: quote.feeMinor,
                tradeId: trade.id,
              },
            ]
          : []),
      ]);
    } else {
      await recordBalancedTransfer(tx, [
        {
          userId: null,
          account: LedgerAccount.AMM_LIQUIDITY,
          reason: LedgerReason.TRADE_SELL,
          amount: -quote.grossCostMinor,
          tradeId: trade.id,
        },
        {
          userId: input.userId,
          account: LedgerAccount.USER_CASH,
          reason: LedgerReason.TRADE_SELL,
          amount: quote.totalUserCashMinor,
          tradeId: trade.id,
        },
        ...(quote.feeMinor > 0n
          ? [
              {
                userId: null,
                account: LedgerAccount.FEE_SINK,
                reason: LedgerReason.TRADE_FEE,
                amount: quote.feeMinor,
                tradeId: trade.id,
              },
            ]
          : []),
      ]);
    }

    const balanceAfterMinor = balanceBeforeMinor + quote.userNetCashDeltaMinor;
    if (balanceAfterMinor < 0n) {
      throw new Error('insufficient_funds');
    }

    const balanceBeforeCoins = Number(balanceBeforeMinor / MINOR_UNITS_PER_COIN);
    const balanceAfterCoins = await syncUserCoinBalanceMirror(
      tx,
      input.userId,
      balanceAfterMinor,
    );
    const coinsDelta = balanceAfterCoins - balanceBeforeCoins;

    if (legacyAssetId != null) {
      await tx.transaction.create({
        data: {
          userId: input.userId,
          assetKind: legacyKind,
          assetId: legacyAssetId,
          side: normSide.toLowerCase(),
          shares,
          price: quote.avgExecutionPrice,
          coinsDelta,
          reason: 'market_order',
        },
      });
    }

    return {
      tradeId: trade.id,
      assetId: lockedAsset.id,
      quote,
      price: quote.avgExecutionPrice,
      spotPriceAfter: quote.spotPriceAfter,
      coinsDeltaMinor: quote.userNetCashDeltaMinor,
      coinsDelta,
      balanceAfterMinor,
      balanceAfterCoins,
    };
  });
}
