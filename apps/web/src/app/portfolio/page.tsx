import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { latestPricesByPlayerIds, latestPricesByTeamIds } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function Portfolio() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const [me, holdings, txs, pendingPredictions] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.holding.findMany({ where: { userId } }),
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.prediction.findMany({
      where: { userId, resolved: false },
      include: {
        match: { include: { home: { select: { name: true } }, away: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const playerIds = holdings.filter((h) => h.assetKind === 'player').map((h) => h.assetId);
  const teamIds = holdings.filter((h) => h.assetKind === 'team').map((h) => h.assetId);
  const [playerPriceMap, teamPriceMap, players, teams] = await Promise.all([
    latestPricesByPlayerIds(playerIds),
    latestPricesByTeamIds(teamIds),
    prisma.player.findMany({ where: { id: { in: playerIds } } }),
    prisma.team.findMany({ where: { id: { in: teamIds } } }),
  ]);
  const playerById = new Map(players.map((p) => [p.id, p]));
  const teamById = new Map(teams.map((t) => [t.id, t]));

  let totalValue = me?.coinBalance ?? 0;
  let totalCost = 0;
  const rows = holdings.map((h) => {
    const price = (h.assetKind === 'player' ? playerPriceMap : teamPriceMap).get(h.assetId) ?? 0;
    const value = price * h.shares;
    const cost = h.avgCost * h.shares;
    totalValue += value;
    totalCost += cost;
    const name = h.assetKind === 'player' ? playerById.get(h.assetId)?.fullName : teamById.get(h.assetId)?.name;
    return { ...h, price, value, cost, name: name ?? '—' };
  });

  const pnl = rows.reduce((s, r) => s + (r.value - r.cost), 0);
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="card"><div className="text-mute text-xs uppercase">Balance</div><div className="font-mono text-2xl">{me?.coinBalance.toLocaleString()}</div></div>
        <div className="card"><div className="text-mute text-xs uppercase">Holdings value</div><div className="font-mono text-2xl">{(totalValue - (me?.coinBalance ?? 0)).toFixed(2)}</div></div>
        <div className="card"><div className="text-mute text-xs uppercase">Net worth</div><div className="font-mono text-2xl">{totalValue.toFixed(2)}</div></div>
        <div className="card"><div className="text-mute text-xs uppercase">PnL</div><div className={`font-mono text-2xl ${pnl >= 0 ? 'up' : 'down'}`}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} ({pnlPct.toFixed(1)}%)</div></div>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Holdings</h2>
        {rows.length === 0 ? (
          <p className="text-mute text-sm">No holdings yet. <Link className="text-accent" href="/players">Browse players</Link>.</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="t">
              <thead>
                <tr>
                  <th>Asset</th><th>Kind</th><th className="text-right">Shares</th><th className="text-right">Avg cost</th><th className="text-right">Price</th><th className="text-right">Value</th><th className="text-right">PnL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const dpnl = r.value - r.cost;
                  const href = r.assetKind === 'player' ? `/players/${r.assetId}` : `/teams/${r.assetId}`;
                  return (
                    <tr key={r.id}>
                      <td><Link className="hover:text-accent" href={href}>{r.name}</Link></td>
                      <td><span className="chip">{r.assetKind}</span></td>
                      <td className="text-right font-mono">{r.shares}</td>
                      <td className="text-right font-mono">{r.avgCost.toFixed(2)}</td>
                      <td className="text-right font-mono">{r.price.toFixed(2)}</td>
                      <td className="text-right font-mono">{r.value.toFixed(2)}</td>
                      <td className={`text-right font-mono ${dpnl >= 0 ? 'up' : 'down'}`}>{dpnl >= 0 ? '+' : ''}{dpnl.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pendingPredictions.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Pending predictions</h2>
          <div className="card overflow-x-auto">
            <table className="t">
              <thead>
                <tr><th>Match</th><th>Pick</th><th className="text-right">Staked</th><th>Status</th></tr>
              </thead>
              <tbody>
                {pendingPredictions.map((p) => (
                  <tr key={p.id}>
                    <td className="text-sm">{p.match.home.name} vs {p.match.away.name}</td>
                    <td><span className="chip">{p.pick === 'H' ? `${p.match.home.name} win` : p.pick === 'A' ? `${p.match.away.name} win` : 'Draw'}</span></td>
                    <td className="text-right font-mono">{p.coinsStaked}</td>
                    <td><span className="text-mute text-xs">Pending</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">Recent activity</h2>
        <div className="card overflow-x-auto">
          <table className="t">
            <thead>
              <tr><th>When</th><th>Side</th><th>Kind</th><th>Asset</th><th className="text-right">Shares</th><th className="text-right">Price</th><th className="text-right">Coins</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <tr key={t.id}>
                  <td className="text-mute">{new Date(t.createdAt).toLocaleString()}</td>
                  <td>{t.side}</td>
                  <td>{t.assetKind}</td>
                  <td className="font-mono text-xs">{t.assetId ?? '—'}</td>
                  <td className="text-right font-mono">{t.shares}</td>
                  <td className="text-right font-mono">{t.price.toFixed(2)}</td>
                  <td className={`text-right font-mono ${t.coinsDelta >= 0 ? 'up' : 'down'}`}>{t.coinsDelta >= 0 ? '+' : ''}{t.coinsDelta}</td>
                  <td className="text-mute text-xs">{t.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {txs.length === 0 && <p className="text-mute text-sm">No activity yet.</p>}
        </div>
      </section>
    </div>
  );
}
