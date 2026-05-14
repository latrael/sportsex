import { prisma } from './db';

export type AssetKind = 'player' | 'team';

// Latest price for a single asset. Falls back to a synthesized 50 if missing.
export async function latestPrice(kind: AssetKind, id: number): Promise<number> {
  const v = await prisma.valuation.findFirst({
    where: kind === 'player' ? { playerId: id } : { teamId: id },
    orderBy: { computedAt: 'desc' },
  });
  return v?.price ?? 50;
}

// Latest prices for many assets in one query.
export async function latestPricesByPlayerIds(ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.valuation.findMany({
    where: { playerId: { in: ids } },
    orderBy: { id: 'desc' },
    distinct: ['playerId'],
    select: { playerId: true, price: true },
  });
  const map = new Map<number, number>();
  for (const r of rows) if (r.playerId != null) map.set(r.playerId, r.price);
  return map;
}

export async function latestPricesByTeamIds(ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.valuation.findMany({
    where: { teamId: { in: ids } },
    orderBy: { id: 'desc' },
    distinct: ['teamId'],
    select: { teamId: true, price: true },
  });
  const map = new Map<number, number>();
  for (const r of rows) if (r.teamId != null) map.set(r.teamId, r.price);
  return map;
}

// Net buys in shares over the last 24h for a player.
export async function netBuys24hForPlayer(playerId: number): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const txs = await prisma.transaction.findMany({
    where: {
      assetKind: 'player',
      assetId: playerId,
      createdAt: { gte: since },
      side: { in: ['buy', 'sell'] },
    },
    select: { side: true, shares: true },
  });
  let net = 0;
  for (const t of txs) net += t.side === 'buy' ? t.shares : -t.shares;
  return net;
}

// Top movers by % change over last 24h.
export async function topMovers(limit = 10): Promise<
  { playerId: number; latest: number; prior: number; pct: number }[]
> {
  // Cheap approach: pull last 24h valuations, group, compute pct.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await prisma.valuation.findMany({
    where: { playerId: { not: null }, computedAt: { gte: since } },
    orderBy: { computedAt: 'asc' },
  });
  type Bucket = { first: number; last: number };
  const byPlayer = new Map<number, Bucket>();
  for (const v of recent) {
    if (v.playerId == null) continue;
    const b = byPlayer.get(v.playerId);
    if (!b) byPlayer.set(v.playerId, { first: v.price, last: v.price });
    else b.last = v.price;
  }
  const arr = Array.from(byPlayer.entries())
    .map(([playerId, b]) => ({
      playerId,
      latest: b.last,
      prior: b.first,
      pct: b.first > 0 ? (b.last - b.first) / b.first : 0,
    }))
    .filter((x) => x.prior !== x.latest)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, limit);
  return arr;
}
