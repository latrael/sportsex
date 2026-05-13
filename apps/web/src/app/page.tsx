import Link from 'next/link';
import { prisma } from '@/lib/db';
import { latestPricesByPlayerIds, topMovers } from '@/lib/queries';

export default async function Home() {
  const [playerCount, teamCount, txCount, latestPlayers] = await Promise.all([
    prisma.player.count(),
    prisma.team.count(),
    prisma.transaction.count({ where: { side: { in: ['buy', 'sell'] } } }),
    prisma.player.findMany({
      take: 12,
      orderBy: [{ goals: 'desc' }, { assists: 'desc' }],
      include: { team: true },
    }),
  ]);
  const priceMap = await latestPricesByPlayerIds(latestPlayers.map((p) => p.id));
  const movers = await topMovers(8);
  const moverPlayers = await prisma.player.findMany({
    where: { id: { in: movers.map((m) => m.playerId) } },
    include: { team: true },
  });
  const byId = new Map(moverPlayers.map((p) => [p.id, p]));

  return (
    <div className="space-y-8">
      <section className="card">
        <h1 className="text-3xl font-bold mb-2">Invest in your sports takes.</h1>
        <p className="text-mute">
          Buy and sell virtual shares of EPL players and teams. Prices move on match performance
          and on what other users are doing. No real money — just bragging rights.
        </p>
        <div className="flex gap-6 mt-4 text-sm">
          <div><span className="text-mute">Players</span> · <span className="font-mono">{playerCount}</span></div>
          <div><span className="text-mute">Teams</span> · <span className="font-mono">{teamCount}</span></div>
          <div><span className="text-mute">Trades</span> · <span className="font-mono">{txCount}</span></div>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Top movers (24h)</h2>
        {movers.length === 0 ? (
          <p className="text-mute text-sm">No price moves yet. Sign up, buy something, or run a simulated match.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {movers.map((m) => {
              const p = byId.get(m.playerId);
              if (!p) return null;
              return (
                <Link key={m.playerId} href={`/players/${p.id}`} className="card flex items-center gap-3 hover:border-accent">
                  <span className={`chip pos-${p.posBucket ?? 'OTHER'}`}>{p.posBucket}</span>
                  <div className="flex-1">
                    <div className="font-medium">{p.fullName}</div>
                    <div className="text-mute text-xs">{p.team?.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono">{m.latest.toFixed(2)}</div>
                    <div className={`text-xs ${m.pct >= 0 ? 'up' : 'down'}`}>
                      {m.pct >= 0 ? '+' : ''}{(m.pct * 100).toFixed(1)}%
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Top scorers</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {latestPlayers.map((p) => (
            <Link key={p.id} href={`/players/${p.id}`} className="card hover:border-accent">
              <div className="flex items-center gap-2 mb-1">
                <span className={`chip pos-${p.posBucket ?? 'OTHER'}`}>{p.posBucket}</span>
                <span className="font-medium">{p.fullName}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-mute">{p.team?.name}</span>
                <span className="font-mono">{(priceMap.get(p.id) ?? 0).toFixed(2)}</span>
              </div>
              <div className="text-xs text-mute mt-1">{p.goals}G · {p.assists}A · {p.minutes}min</div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
