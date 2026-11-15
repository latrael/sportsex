/**
 * R4.4 — Durable DB-backed per-user order rate limiter, plus backward-compatible
 * `lastOrderAt` Map for legacy test helpers that call `lastOrderAt.clear()` /
 * `lastOrderAt.delete(userId)`.
 *
 * Why DB-backed (REBUILD_PLAN §2 & TODO_2627.md R4.4):
 *   On Vercel serverless, each invocation may land on a fresh Node isolate where
 *   an in-process `Map` is empty. Checking the newest `trade.createdAt` (and v1
 *   `transaction.createdAt`) inside the database enforces the cooldown across
 *   separate serverless instances with zero external Redis/Upstash dependency.
 *
 *   To keep existing test suites (`lastOrderAt.delete(user.id)` / `lastOrderAt.clear()`)
 *   able to explicitly bypass cooldown in back-to-back test steps, `lastOrderAt`
 *   also tracks a per-user reset watermark when `.delete(userId)` or `.clear()`
 *   is called.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

export const ORDER_COOLDOWN_MS = 1000;

type DbTx = Prisma.TransactionClient | PrismaClient;

class CooldownStore extends Map<string, number> {
  private clearedWatermark = 0;
  private deletedUsers = new Map<string, number>();

  override clear(): void {
    super.clear();
    this.clearedWatermark = Date.now() + 1;
    this.deletedUsers.clear();
  }

  override delete(key: string): boolean {
    this.deletedUsers.set(key, Date.now() + 1);
    return super.delete(key);
  }

  override set(key: string, value: number): this {
    this.deletedUsers.delete(key);
    return super.set(key, value);
  }

  getResetFloor(userId: string): number {
    return Math.max(this.clearedWatermark, this.deletedUsers.get(userId) ?? 0);
  }
}

export const lastOrderAt = new CooldownStore();

/**
 * Durable cooldown check that reads the latest trade timestamp from Postgres
 * (so separate serverless invocations share the same state) as well as any
 * in-process timestamp.
 *
 * @param db Prisma client or transaction
 * @param userId User ID placing the order
 * @param nowMs Current epoch milliseconds (injectable for deterministic tests)
 * @param opts.isolatedProcess Simulate a fresh serverless invocation (ignores in-memory map, reads DB only)
 */
export async function checkOrderCooldown(
  db: DbTx,
  userId: string,
  nowMs: number = Date.now(),
  opts?: { cooldownMs?: number; isolatedProcess?: boolean },
): Promise<{ allowed: boolean; lastAtMs: number }> {
  const cooldownMs = opts?.cooldownMs ?? ORDER_COOLDOWN_MS;
  const resetFloor = opts?.isolatedProcess ? 0 : lastOrderAt.getResetFloor(userId);
  const inMemLast = opts?.isolatedProcess ? 0 : (lastOrderAt.get(userId) ?? 0);

  const [latestTrade, latestV1Tx] = await Promise.all([
    db.trade.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    }),
    db.transaction.findFirst({
      where: { userId, reason: 'market_order' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    }),
  ]);

  const dbTradeMs = latestTrade?.createdAt.getTime() ?? 0;
  const dbTxMs = latestV1Tx?.createdAt.getTime() ?? 0;
  const dbLast = Math.max(dbTradeMs, dbTxMs);

  const effectiveDbLast = dbLast >= resetFloor ? dbLast : 0;
  const effectiveLast = Math.max(inMemLast, effectiveDbLast);

  if (effectiveLast > 0 && nowMs - effectiveLast < cooldownMs) {
    return { allowed: false, lastAtMs: effectiveLast };
  }

  return { allowed: true, lastAtMs: effectiveLast };
}

export function recordOrderCooldown(userId: string, nowMs: number = Date.now()): void {
  lastOrderAt.set(userId, nowMs);
}
