/**
 * R4.3 — Single-transaction AMM trade execution engine (pure schema v2).
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
 */

import {
  AssetKind,
  LedgerAccount,
  LedgerReason,
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
  /** Either pass `v2AssetId` directly or `(assetKind, assetId)`. */
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
  /** Signed cash delta in whole coins. */
  coinsDelta: number;
  /** User's updated balance in minor units (`bigint`). */
  balanceAfterMinor: MinorUnits;
  /** User's updated balance in whole coins. */
  balanceAfterCoins: number;
}

/**
 * Resolve a v2 `Asset` and its latest `FairValue` for a request specifying
 * `v2AssetId` or `(assetKind, assetId)` (where `assetId` can be `Asset.id`,
 * `PlayerSeason.id`, `Player.id`, `ClubSeason.id`, or `Club.id`).
 */
async function resolveAsset(
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
      floatShares: asset.kind === AssetKind.CLUB ? 4000 : DEFAULT_FLOAT_SHARES,
    };
  }

  const kind = input.assetKind ?? 'player';
  const targetId = input.assetId!;

  const asset =
    kind === 'player'
      ? (await tx.asset.findFirst({
          where: { kind: AssetKind.PLAYER, playerSeason: { playerId: targetId } },
          orderBy: { id: 'desc' },
        })) ??
        (await tx.asset.findUnique({ where: { id: targetId } })) ??
        (await tx.asset.findUnique({ where: { playerSeasonId: targetId } }))
      : (await tx.asset.findFirst({
          where: { kind: AssetKind.CLUB, clubSeason: { clubId: targetId } },
          orderBy: { id: 'desc' },
        })) ??
        (await tx.asset.findUnique({ where: { id: targetId } })) ??
        (await tx.asset.findUnique({ where: { clubSeasonId: targetId } }));

  if (!asset) {
    throw new Error('no_asset');
  }

  const latestFv = await tx.fairValue.findFirst({
    where: { assetId: asset.id },
    orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
  });

  if (!latestFv || Number(latestFv.value) <= 0) {
    throw new Error('no_price');
  }

  return {
    asset,
    fairValue: latestFv.value,
    floatShares: kind === 'team' ? 4000 : DEFAULT_FLOAT_SHARES,
  };
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

    // 2. Resolve the target Asset and lock it FOR UPDATE
    const resolved = await resolveAsset(tx, input);
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

    // 6. Check and update user Position
    const existingPos = await tx.position.findUnique({
      where: { userId_assetId: { userId: input.userId, assetId: lockedAsset.id } },
    });

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
    } else {
      const newShares = existingPos!.shares - shares;
      if (newShares === 0) {
        await tx.position.delete({ where: { id: existingPos!.id } });
      } else {
        await tx.position.update({
          where: { id: existingPos!.id },
          data: { shares: newShares },
        });
      }
    }

    // 7. Update Asset inventory q -> qAfter
    await tx.asset.update({
      where: { id: lockedAsset.id },
      data: { inventory: quote.inventoryAfter },
    });

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

    // 10. Record balanced double-entry LedgerEntry legs (Invariant 2)
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
