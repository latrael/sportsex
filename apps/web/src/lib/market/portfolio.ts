/**
 * R5.5 — Portfolio & leaderboard mark-to-market calculations backed by the
 * double-entry ledger (`ledger_entry`) and `position` + `price_tick`.
 */

import { AssetKind, LedgerAccount } from '@prisma/client';
import { prisma } from '@/lib/db';
import { minorUnitsToCoinsDecimal, MINOR_UNITS_PER_COIN } from '@/lib/money';
import { latestPricesByAssetIds } from '@/lib/queries';
import { getOrInitUserBalanceMinor } from './ledger';

export interface PortfolioPositionRow {
  positionId: number;
  assetId: number;
  assetKind: 'player' | 'team';
  targetId: number;
  name: string;
  subtitle: string;
  shares: number;
  avgCost: number;
  price: number;
  value: number;
  cost: number;
  pnl: number;
}

export interface PortfolioSummary {
  userId: string;
  balanceMinor: bigint;
  cashBalance: number;
  holdingsValue: number;
  totalCost: number;
  netWorth: number;
  pnl: number;
  pnlPct: number;
  positions: PortfolioPositionRow[];
}

/**
 * Compute a user's exact portfolio summary from `ledger_entry` (`USER_CASH`)
 * and `position` mark-to-market against the canonical latest `price_tick`.
 */
export async function getUserPortfolioSummary(userId: string): Promise<PortfolioSummary> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const balanceMinor = await getOrInitUserBalanceMinor(
    prisma,
    userId,
    user?.coinBalance ?? 10000,
  );
  const cashBalance = Number(minorUnitsToCoinsDecimal(balanceMinor));

  const positions = await prisma.position.findMany({
    where: { userId, shares: { gt: 0 } },
    include: {
      asset: {
        include: {
          playerSeason: {
            include: {
              player: true,
              clubSeason: { include: { club: true } },
            },
          },
          clubSeason: {
            include: { club: true },
          },
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  const priceMap = await latestPricesByAssetIds(positions.map((p) => p.assetId));

  const rows: PortfolioPositionRow[] = positions.map((pos) => {
    const price = priceMap.get(pos.assetId) ?? 50;
    const avgCost = Number(pos.avgCost);
    const value = price * pos.shares;
    const cost = avgCost * pos.shares;
    const pnl = value - cost;

    if (pos.asset.kind === AssetKind.PLAYER && pos.asset.playerSeason) {
      const ps = pos.asset.playerSeason;
      return {
        positionId: pos.id,
        assetId: pos.assetId,
        assetKind: 'player',
        targetId: ps.player.id,
        name: `${ps.player.firstName} ${ps.player.secondName}`.trim(),
        subtitle: ps.clubSeason.club.shortName,
        shares: pos.shares,
        avgCost,
        price,
        value,
        cost,
        pnl,
      };
    } else {
      const cs = pos.asset.clubSeason;
      return {
        positionId: pos.id,
        assetId: pos.assetId,
        assetKind: 'team',
        targetId: cs?.club.id ?? pos.assetId,
        name: cs?.club.name ?? `Asset #${pos.assetId}`,
        subtitle: cs?.club.shortName ?? 'CLUB',
        shares: pos.shares,
        avgCost,
        price,
        value,
        cost,
        pnl,
      };
    }
  });

  const holdingsValue = rows.reduce((sum, r) => sum + r.value, 0);
  const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);
  const netWorth = cashBalance + holdingsValue;
  const pnl = holdingsValue - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  return {
    userId,
    balanceMinor,
    cashBalance,
    holdingsValue,
    totalCost,
    netWorth,
    pnl,
    pnlPct,
    positions: rows,
  };
}

export interface LeaderboardEntry {
  user: { id: string; handle: string; email: string };
  cashBalance: number;
  holdingsValue: number;
  netWorth: number;
}

/**
 * Compute leaderboard rankings directly from `ledger_entry` (`USER_CASH`) and
 * mark-to-market `position` rows.
 */
export async function getLeaderboardRankings(
  scopedUserIds?: string[] | null,
): Promise<LeaderboardEntry[]> {
  const users = await prisma.user.findMany({
    where: scopedUserIds ? { id: { in: scopedUserIds } } : undefined,
    select: { id: true, handle: true, email: true, coinBalance: true },
    take: 200,
  });

  if (users.length === 0) return [];
  const userIds = users.map((u) => u.id);

  const [ledgerAgg, positions] = await Promise.all([
    prisma.ledgerEntry.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
        account: LedgerAccount.USER_CASH,
      },
      _sum: { amount: true },
    }),
    prisma.position.findMany({
      where: { userId: { in: userIds }, shares: { gt: 0 } },
    }),
  ]);

  const ledgerByUserId = new Map<string, bigint>();
  for (const row of ledgerAgg) {
    if (row.userId) {
      ledgerByUserId.set(row.userId, row._sum.amount ?? 0n);
    }
  }

  const allAssetIds = Array.from(new Set(positions.map((p) => p.assetId)));
  const priceMap = await latestPricesByAssetIds(allAssetIds);

  const positionsByUser = new Map<string, typeof positions>();
  for (const p of positions) {
    const list = positionsByUser.get(p.userId) ?? [];
    list.push(p);
    positionsByUser.set(p.userId, list);
  }

  const ranked: LeaderboardEntry[] = users.map((u) => {
    const ledgerMinor = ledgerByUserId.get(u.id);
    const cashBalance =
      ledgerMinor !== undefined
        ? Number(minorUnitsToCoinsDecimal(ledgerMinor))
        : Number(BigInt(u.coinBalance) * MINOR_UNITS_PER_COIN) / 100;

    const mine = positionsByUser.get(u.id) ?? [];
    const holdingsValue = mine.reduce((sum, pos) => {
      const price = priceMap.get(pos.assetId) ?? 50;
      return sum + price * pos.shares;
    }, 0);

    return {
      user: { id: u.id, handle: u.handle, email: u.email },
      cashBalance,
      holdingsValue,
      netWorth: cashBalance + holdingsValue,
    };
  });

  ranked.sort((a, b) => b.netWorth - a.netWorth || a.user.handle.localeCompare(b.user.handle));
  return ranked;
}
