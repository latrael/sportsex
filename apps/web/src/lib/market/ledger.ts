/**
 * R4.2 — Double-entry ledger (`ledger_entry`).
 *
 * Principles (REBUILD_PLAN §"Target architecture" 3 & §"Enforced invariants" 2, 5):
 *   1. Every coin movement is an atomic transfer (`transferId`) of balanced legs
 *      whose signed `amount` values (`BigInt` minor units) sum to **0n**.
 *   2. A user's cash balance is the signed sum of their `USER_CASH` rows in
 *      `ledger_entry` (`SUM(amount) WHERE user_id = ? AND account = 'USER_CASH'`).
 *      If a user has no `ledger_entry` rows yet (e.g. a legacy test fixture that
 *      created a `User` directly via `db.user.create` without calling `mintUserGrant`),
 *      `ensureUserLedgerSeeded` lazily seeds their initial `COIN_GRANT` from
 *      `user.coinBalance` inside the transaction so existing callers work seamlessly
 *      while all subsequent balance checks and updates are 100% ledger-driven!
 *   3. Total coins in circulation (`SUM(USER_CASH) + SUM(AMM_LIQUIDITY)`) changes
 *      only via explicit `MINT` credits and `FEE_SINK` burns (Invariant 2).
 */

import { randomUUID } from 'crypto';
import {
  LedgerAccount,
  LedgerReason,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import {
  MINOR_UNITS_PER_COIN,
  coinsToMinorUnits,
  type MinorUnits,
} from '@/lib/money';

type DbTx = Prisma.TransactionClient | PrismaClient;

export interface LedgerLegInput {
  userId?: string | null;
  account: LedgerAccount;
  reason: LedgerReason;
  amount: MinorUnits;
  tradeId?: number | null;
}

/**
 * Record a balanced double-entry transfer. Throws if the legs do not sum to `0n`.
 */
export async function recordBalancedTransfer(
  tx: DbTx,
  legs: readonly LedgerLegInput[],
  transferId: string = randomUUID(),
): Promise<string> {
  if (legs.length < 2) {
    throw new Error('recordBalancedTransfer requires at least 2 legs');
  }
  let sum = 0n;
  for (const leg of legs) {
    sum += leg.amount;
  }
  if (sum !== 0n) {
    throw new Error(
      `Ledger invariant violation: transfer ${transferId} legs sum to ${sum.toString()} (expected 0n)`,
    );
  }

  await tx.ledgerEntry.createMany({
    data: legs.map((leg) => ({
      userId: leg.userId ?? null,
      account: leg.account,
      reason: leg.reason,
      amount: leg.amount,
      transferId,
      tradeId: leg.tradeId ?? null,
    })),
  });

  return transferId;
}

/**
 * Ensure a user has their initial `COIN_GRANT` recorded in `ledger_entry` if they
 * were created without ledger entries (bridges existing `createUser` fixtures),
 * then return their authoritative ledger balance in minor units (`bigint`).
 */
export async function getOrInitUserBalanceMinor(
  tx: DbTx,
  userId: string,
  fallbackWholeCoins?: number,
): Promise<MinorUnits> {
  const agg = await tx.ledgerEntry.aggregate({
    where: { userId, account: LedgerAccount.USER_CASH },
    _sum: { amount: true },
    _count: { _all: true },
  });

  if (agg._count._all === 0) {
    let seedCoins = fallbackWholeCoins;
    if (seedCoins === undefined) {
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { coinBalance: true },
      });
      seedCoins = u?.coinBalance ?? 0;
    }
    if (seedCoins > 0) {
      const grantMinor = coinsToMinorUnits(seedCoins);
      await recordBalancedTransfer(tx, [
        {
          userId: null,
          account: LedgerAccount.MINT,
          reason: LedgerReason.COIN_GRANT,
          amount: -grantMinor,
        },
        {
          userId,
          account: LedgerAccount.USER_CASH,
          reason: LedgerReason.COIN_GRANT,
          amount: grantMinor,
        },
      ]);
      return grantMinor;
    }
    return 0n;
  }

  return agg._sum.amount ?? 0n;
}

/**
 * Query a user's ledger-derived balance in minor units (`bigint`), without mutating.
 */
export async function getUserBalanceMinor(tx: DbTx, userId: string): Promise<MinorUnits> {
  const agg = await tx.ledgerEntry.aggregate({
    where: { userId, account: LedgerAccount.USER_CASH },
    _sum: { amount: true },
    _count: { _all: true },
  });
  if (agg._count._all === 0) {
    const u = await tx.user.findUnique({
      where: { id: userId },
      select: { coinBalance: true },
    });
    return coinsToMinorUnits(u?.coinBalance ?? 0);
  }
  return agg._sum.amount ?? 0n;
}

/**
 * Synchronise the denormalised `user.coinBalance` (whole coins integer) from the
 * authoritative ledger balance so legacy UI reads stay accurate until Phase 5
 * finishes rewiring every page.
 */
export async function syncUserCoinBalanceMirror(
  tx: DbTx,
  userId: string,
  balanceMinor: MinorUnits,
): Promise<number> {
  const wholeCoins = Number(balanceMinor / MINOR_UNITS_PER_COIN);
  await tx.user.update({
    where: { id: userId },
    data: { coinBalance: wholeCoins },
  });
  return wholeCoins;
}

/**
 * Mint coins to a user via `MINT` → `USER_CASH` (signup grant, quest reward, prediction payout).
 */
export async function mintToUser(
  tx: DbTx,
  opts: {
    userId: string;
    amountMinor: MinorUnits;
    reason: LedgerReason;
  },
): Promise<{ balanceMinor: MinorUnits; transferId: string }> {
  if (opts.amountMinor <= 0n) {
    throw new RangeError(`mintToUser amountMinor must be > 0n, got ${opts.amountMinor}`);
  }
  const current = await getOrInitUserBalanceMinor(tx, opts.userId);
  const transferId = await recordBalancedTransfer(tx, [
    {
      userId: null,
      account: LedgerAccount.MINT,
      reason: opts.reason,
      amount: -opts.amountMinor,
    },
    {
      userId: opts.userId,
      account: LedgerAccount.USER_CASH,
      reason: opts.reason,
      amount: opts.amountMinor,
    },
  ]);
  const next = current + opts.amountMinor;
  await syncUserCoinBalanceMirror(tx, opts.userId, next);
  return { balanceMinor: next, transferId };
}

export interface LedgerReconciliationReport {
  ok: boolean;
  totalEntries: number;
  globalSumMinor: MinorUnits;
  unbalancedTransfers: { transferId: string; sumMinor: MinorUnits }[];
  negativeUserBalances: { userId: string; balanceMinor: MinorUnits }[];
  accountTotals: Record<LedgerAccount, MinorUnits>;
  /**
   * Invariant 2 check:
   *   `USER_CASH + AMM_LIQUIDITY === (-MINT) - FEE_SINK`
   *   (Total coins held by users and AMM equals total coins minted minus fees burned).
   */
  circulationConserved: boolean;
}

/**
 * Reconcile the entire `ledger_entry` table (Invariants 2 and 5).
 */
export async function reconcileLedger(db: DbTx): Promise<LedgerReconciliationReport> {
  const entries = await db.ledgerEntry.findMany();

  let globalSumMinor = 0n;
  const byTransfer = new Map<string, MinorUnits>();
  const byUser = new Map<string, MinorUnits>();
  const accountTotals: Record<LedgerAccount, MinorUnits> = {
    USER_CASH: 0n,
    AMM_LIQUIDITY: 0n,
    FEE_SINK: 0n,
    MINT: 0n,
  };

  for (const e of entries) {
    globalSumMinor += e.amount;
    accountTotals[e.account] += e.amount;
    byTransfer.set(e.transferId, (byTransfer.get(e.transferId) ?? 0n) + e.amount);
    if (e.account === LedgerAccount.USER_CASH && e.userId) {
      byUser.set(e.userId, (byUser.get(e.userId) ?? 0n) + e.amount);
    }
  }

  const unbalancedTransfers: { transferId: string; sumMinor: MinorUnits }[] = [];
  for (const [transferId, sumMinor] of byTransfer.entries()) {
    if (sumMinor !== 0n) {
      unbalancedTransfers.push({ transferId, sumMinor });
    }
  }

  const negativeUserBalances: { userId: string; balanceMinor: MinorUnits }[] = [];
  for (const [userId, balanceMinor] of byUser.entries()) {
    if (balanceMinor < 0n) {
      negativeUserBalances.push({ userId, balanceMinor });
    }
  }

  const totalMinted = -accountTotals.MINT;
  const totalFeesBurned = accountTotals.FEE_SINK;
  const totalInCirculation = accountTotals.USER_CASH + accountTotals.AMM_LIQUIDITY;
  const circulationConserved = totalInCirculation === totalMinted - totalFeesBurned;

  const ok =
    globalSumMinor === 0n &&
    unbalancedTransfers.length === 0 &&
    negativeUserBalances.length === 0 &&
    circulationConserved;

  return {
    ok,
    totalEntries: entries.length,
    globalSumMinor,
    unbalancedTransfers,
    negativeUserBalances,
    accountTotals,
    circulationConserved,
  };
}
