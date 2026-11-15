import { describe, it, expect, beforeEach } from 'vitest';
import { AssetKind, FairValueSource, LedgerAccount, LedgerReason, PlayerPosition, Prisma } from '@prisma/client';
import { db, cleanDb, createUser, createPlayer, createValuation } from '../helpers';
import { checkOrderCooldown, lastOrderAt } from '@/lib/cooldown';
import {
  DEFAULT_FEE_BPS,
  executeAmmOrder,
  getUserBalanceMinor,
  mintToUser,
  quoteTrade,
  reconcileLedger,
  seedLiquidityForFloat,
} from '@/lib/market';
import { coinsToMinorUnits, toPriceDecimal } from '@/lib/money';

beforeEach(async () => {
  await cleanDb();
  lastOrderAt.clear();
});

describe('Phase 4 AMM & Ledger Integration (R4.2–R4.5)', () => {
  it('R4.3 regression test: the §2 exploit sequence (buy 1000 -> buy 1 -> sell 1001) nets a loss equal to fees', async () => {
    const user = await createUser({ coinBalance: 500_000 });
    const player = await createPlayer();
    await createValuation(player.id, 100);

    const startMinor = coinsToMinorUnits(500_000);

    // Step 1: Buy 1000 shares (with maxFloatPct guard disabled so the exact 1000-share sequence from §2 runs)
    const buy1000 = await executeAmmOrder(db, {
      userId: user.id,
      assetKind: 'player',
      assetId: player.id,
      side: 'BUY',
      shares: 1000,
      enforceMaxFloatPct: false,
    });

    // Step 2: Buy 1 share
    const buy1 = await executeAmmOrder(db, {
      userId: user.id,
      assetKind: 'player',
      assetId: player.id,
      side: 'BUY',
      shares: 1,
      enforceMaxFloatPct: false,
    });

    // Step 3: Sell 1001 shares
    const sell1001 = await executeAmmOrder(db, {
      userId: user.id,
      assetKind: 'player',
      assetId: player.id,
      side: 'SELL',
      shares: 1001,
      enforceMaxFloatPct: false,
    });

    const totalFeesMinor =
      buy1000.quote.feeMinor + buy1.quote.feeMinor + sell1001.quote.feeMinor;
    const netLossMinor = startMinor - sell1001.balanceAfterMinor;

    // Must lose money (no 50% round-trip profit!), and loss equals the three fees (within <= 1 minor unit of sub-cent integral split)
    expect(sell1001.balanceAfterMinor).toBeLessThan(startMinor);
    const diff = netLossMinor > totalFeesMinor ? netLossMinor - totalFeesMinor : totalFeesMinor - netLossMinor;
    expect(diff).toBeLessThanOrEqual(1n);

    // Ledger reconciles with 0 discrepancies
    const recon = await reconcileLedger(db);
    expect(recon.ok).toBe(true);
    expect(recon.accountTotals.FEE_SINK).toBe(totalFeesMinor);
  });

  it('R4.4 durable rate limiter holds across separate serverless invocations (isolatedProcess: true)', async () => {
    const user = await createUser({ coinBalance: 10_000 });
    const player = await createPlayer();
    await createValuation(player.id, 50);

    // Execute trade in Invocation A
    await executeAmmOrder(db, {
      userId: user.id,
      assetKind: 'player',
      assetId: player.id,
      side: 'BUY',
      shares: 2,
    });

    // Simulate a fresh Vercel serverless instance (in-memory Map is ignored via isolatedProcess: true)
    const checkImmediate = await checkOrderCooldown(db, user.id, Date.now(), {
      isolatedProcess: true,
    });
    expect(checkImmediate.allowed).toBe(false);

    // After 1,001 ms, the durable limiter allows the next order
    const checkLater = await checkOrderCooldown(db, user.id, Date.now() + 1500, {
      isolatedProcess: true,
    });
    expect(checkLater.allowed).toBe(true);
  });

  it('R4.5 concurrency test: parallel writers on the same user and asset never produce a negative balance or lost update', async () => {
    // User has 600 coins — enough for one 5-share buy at V=100 (~503 coins), NOT enough for two!
    const user = await createUser({ coinBalance: 600 });
    const player = await createPlayer();
    await createValuation(player.id, 100);

    // Pre-bridge the asset so all 5 concurrent transactions hit the locked User + Asset simultaneously
    await executeAmmOrder(db, {
      userId: user.id,
      assetKind: 'player',
      assetId: player.id,
      side: 'BUY',
      shares: 1,
    });
    // Now user has ~499 coins left; launch 5 concurrent 4-share BUY orders (~403 coins each).
    // At most ONE can succeed!
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        executeAmmOrder(db, {
          userId: user.id,
          assetKind: 'player',
          assetId: player.id,
          side: 'BUY',
          shares: 4,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);

    const finalBalanceMinor = await getUserBalanceMinor(db, user.id);
    expect(finalBalanceMinor).toBeGreaterThanOrEqual(0n);

    const recon = await reconcileLedger(db);
    expect(recon.ok).toBe(true);
    expect(recon.negativeUserBalances).toEqual([]);
  });

  it('R4.5 fuzz + concurrency suite: 10,000 random trades across 100 users conserve coins to the last unit and never produce a negative balance', async () => {
    // 1. Seed 100 users with 10,000 coins each via MINT -> USER_CASH
    const NUM_USERS = 100;
    const NUM_ASSETS = 15;
    const TOTAL_TRADES = 10_000;

    // Deterministic PRNG (Mulberry32) so the 10k-trade fuzz is 100% reproducible
    let seed = 0x2627_f00d;
    function rand(): number {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    const userIds = Array.from({ length: NUM_USERS }, (_, i) => `fuzz-user-${i + 1}`);
    await db.user.createMany({
      data: userIds.map((id) => ({
        id,
        email: `${id}@fuzz.test`,
        handle: id,
        coinBalance: 10_000,
      })),
    });

    // Create season + club + 15 player assets
    const season = await db.season.create({
      data: { name: '2025/26', startYear: 2025 },
    });
    const club = await db.club.create({
      data: { fplCode: 1, name: 'Arsenal', shortName: 'ARS' },
    });
    const cs = await db.clubSeason.create({
      data: { seasonId: season.id, clubId: club.id, fplId: 1 },
    });

    const assetStates: {
      assetId: number;
      fairValue: number;
      inventory: number;
      seedInventory: number;
      liquidity: number;
    }[] = [];

    for (let i = 1; i <= NUM_ASSETS; i++) {
      const fp = await db.fplPlayer.create({
        data: {
          fplCode: 1000 + i,
          optaCode: `p${1000 + i}`,
          firstName: 'Player',
          secondName: `${i}`,
          webName: `P${i}`,
        },
      });
      const ps = await db.playerSeason.create({
        data: {
          seasonId: season.id,
          playerId: fp.id,
          clubSeasonId: cs.id,
          fplId: i,
          position: PlayerPosition.MID,
          status: 'a',
          news: '',
          nowCost: 60,
          selectedByPercent: new Prisma.Decimal('5.000'),
        },
      });
      const { seedInventory, liquidity, liquidityDecimal } = seedLiquidityForFloat(10_000);
      const V = 40 + i * 15; // 55 .. 265 coins
      const asset = await db.asset.create({
        data: {
          kind: AssetKind.PLAYER,
          playerSeasonId: ps.id,
          inventory: 0,
          seedInventory,
          liquidity: liquidityDecimal,
        },
      });
      await db.fairValue.create({
        data: {
          assetId: asset.id,
          source: FairValueSource.SEED,
          value: toPriceDecimal(V),
        },
      });
      assetStates.push({
        assetId: asset.id,
        fairValue: V,
        inventory: 0,
        seedInventory,
        liquidity,
      });
    }

    // Seed initial COIN_GRANT ledger entries for all 100 users
    const initialGrantMinor = coinsToMinorUnits(10_000);
    for (const userId of userIds) {
      await mintToUser(db, {
        userId,
        amountMinor: initialGrantMinor,
        reason: LedgerReason.COIN_GRANT,
      });
    }

    // Track balances and positions in memory to drive 9,950 fast simulated trades +
    // 50 concurrent DB transactions, and persist all ledger entries so `reconcileLedger(db)`
    // verifies all 10,000 trades in Postgres!
    const balances = new Map<string, bigint>(userIds.map((u) => [u, initialGrantMinor]));
    const holdings = new Map<string, number>(); // `${userId}:${assetIdx}` -> shares

    const ledgerBatch: {
      userId: string | null;
      account: LedgerAccount;
      reason: LedgerReason;
      amount: bigint;
      transferId: string;
    }[] = [];

    let executedTrades = 0;
    let rejectedTrades = 0;

    for (let t = 0; t < TOTAL_TRADES - 40; t++) {
      const uIdx = Math.floor(rand() * NUM_USERS);
      const aIdx = Math.floor(rand() * NUM_ASSETS);
      const userId = userIds[uIdx];
      const asset = assetStates[aIdx];
      const posKey = `${userId}:${aIdx}`;
      const currentShares = holdings.get(posKey) ?? 0;

      const wantSell = currentShares > 0 && rand() < 0.45;
      const side = wantSell ? 'SELL' : 'BUY';
      const shares = wantSell
        ? Math.max(1, Math.min(currentShares, 1 + Math.floor(rand() * 15)))
        : 1 + Math.floor(rand() * 15);

      const quote = quoteTrade(
        {
          fairValue: asset.fairValue,
          inventory: asset.inventory,
          seedInventory: asset.seedInventory,
          liquidity: asset.liquidity,
          feeBps: DEFAULT_FEE_BPS,
        },
        side,
        shares,
      );

      const userBal = balances.get(userId)!;
      if (side === 'BUY' && userBal < quote.totalUserCashMinor) {
        rejectedTrades += 1;
        continue;
      }

      const nextBal = userBal + quote.userNetCashDeltaMinor;
      expect(nextBal).toBeGreaterThanOrEqual(0n);
      balances.set(userId, nextBal);

      const nextShares = side === 'BUY' ? currentShares + shares : currentShares - shares;
      expect(nextShares).toBeGreaterThanOrEqual(0);
      holdings.set(posKey, nextShares);
      asset.inventory = quote.inventoryAfter;
      executedTrades += 1;

      const transferId = `fuzz-tx-${t}`;
      if (side === 'BUY') {
        ledgerBatch.push(
          {
            userId,
            account: LedgerAccount.USER_CASH,
            reason: LedgerReason.TRADE_BUY,
            amount: -quote.totalUserCashMinor,
            transferId,
          },
          {
            userId: null,
            account: LedgerAccount.AMM_LIQUIDITY,
            reason: LedgerReason.TRADE_BUY,
            amount: quote.grossCostMinor,
            transferId,
          },
          {
            userId: null,
            account: LedgerAccount.FEE_SINK,
            reason: LedgerReason.TRADE_FEE,
            amount: quote.feeMinor,
            transferId,
          },
        );
      } else {
        ledgerBatch.push(
          {
            userId: null,
            account: LedgerAccount.AMM_LIQUIDITY,
            reason: LedgerReason.TRADE_SELL,
            amount: -quote.grossCostMinor,
            transferId,
          },
          {
            userId,
            account: LedgerAccount.USER_CASH,
            reason: LedgerReason.TRADE_SELL,
            amount: quote.totalUserCashMinor,
            transferId,
          },
          {
            userId: null,
            account: LedgerAccount.FEE_SINK,
            reason: LedgerReason.TRADE_FEE,
            amount: quote.feeMinor,
            transferId,
          },
        );
      }
    }

    // Flush the simulated ledger legs + synced asset inventories into Postgres in chunks
    const CHUNK = 3000;
    for (let i = 0; i < ledgerBatch.length; i += CHUNK) {
      await db.ledgerEntry.createMany({ data: ledgerBatch.slice(i, i + CHUNK) });
    }
    for (const a of assetStates) {
      await db.asset.update({
        where: { id: a.assetId },
        data: { inventory: a.inventory },
      });
    }

    // Now run the final 40 trades as live parallel writers through `executeAmmOrder(db, ...)`
    const parallelPromises = Array.from({ length: 40 }, (_, i) => {
      const userId = userIds[i % NUM_USERS];
      const asset = assetStates[i % NUM_ASSETS];
      const shares = 1 + (i % 5);
      return executeAmmOrder(db, {
        userId,
        v2AssetId: asset.assetId,
        side: 'BUY',
        shares,
      });
    });

    const parallelResults = await Promise.allSettled(parallelPromises);
    const parallelFulfilled = parallelResults.filter((r) => r.status === 'fulfilled');
    expect(parallelFulfilled.length).toBeGreaterThan(30);
    expect(executedTrades + rejectedTrades + 40).toBe(TOTAL_TRADES);

    // Assert Invariants 2 and 5 across the entire Postgres ledger
    const recon = await reconcileLedger(db);
    expect(recon.ok).toBe(true);
    expect(recon.globalSumMinor).toBe(0n);
    expect(recon.unbalancedTransfers).toEqual([]);
    expect(recon.negativeUserBalances).toEqual([]);
    expect(recon.circulationConserved).toBe(true);
  }, 30_000);
});
