import Link from 'next/link';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { formatPosBadge, queryMarketPlayers, topMovers } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;

  const [playerCount, clubCount, tradeCount, topMarket, movers] = await Promise.all([
    prisma.player.count(),
    prisma.club.count(),
    prisma.trade.count(),
    queryMarketPlayers({ sort: 'price', pageSize: 12 }),
    topMovers(6),
  ]);

  const topPlayers = topMarket.items;
  const posCounts = topMarket.positionCounts;

  return (
    <div className="space-y-16">

      {/* ── Hero ── */}
      <section className="relative rounded-2xl overflow-hidden"
        style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 50%, #3b82f6 100%)' }}>
        <div className="absolute inset-0 opacity-10"
          style={{ backgroundImage: 'radial-gradient(circle at 70% 50%, white 0%, transparent 60%)' }} />
        <div className="relative px-8 py-14 md:py-20 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/15 text-white/90 text-xs font-medium mb-6 border border-white/20">
            <span className="w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse" />
            EPL market open · {playerCount.toLocaleString()} players listed
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white leading-tight tracking-tight mb-4">
            Back the players<br />you believe in.
          </h1>
          <p className="text-blue-100 text-lg leading-relaxed mb-8 max-w-lg">
            A virtual stock market for EPL players and clubs. Prices move with position-normalised
            on-pitch performance and real bonding-curve trading pressure.
          </p>
          <div className="flex flex-wrap gap-3">
            {userId ? (
              <Link href="/players" className="inline-flex items-center gap-2 px-5 py-2.5 bg-white text-accent font-semibold rounded-xl text-sm hover:bg-blue-50 transition-colors">
                Browse market →
              </Link>
            ) : (
              <>
                <Link href="/signup" className="inline-flex items-center gap-2 px-5 py-2.5 bg-white text-accent font-semibold rounded-xl text-sm hover:bg-blue-50 transition-colors">
                  Start investing →
                </Link>
                <a href="#how-it-works" className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/10 border border-white/25 text-white font-medium rounded-xl text-sm hover:bg-white/20 transition-colors">
                  How it works
                </a>
              </>
            )}
          </div>
        </div>

        {/* Floating stat cards */}
        <div className="absolute right-8 top-1/2 -translate-y-1/2 hidden lg:flex flex-col gap-3">
          {[
            { label: 'Players listed', value: playerCount.toLocaleString() },
            { label: 'Clubs', value: clubCount.toString() },
            { label: 'Trades filled', value: tradeCount.toLocaleString() },
          ].map((s) => (
            <div key={s.label} className="px-4 py-3 rounded-xl bg-white/10 border border-white/20 backdrop-blur-sm text-right min-w-[140px]">
              <div className="text-white/60 text-xs font-medium">{s.label}</div>
              <div className="text-white text-2xl font-bold font-mono">{s.value}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Browse by Position (R5.4) ── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-ink">Browse by position</h2>
          <Link href="/players?sort=price" className="text-sm text-accent hover:underline font-medium">Full market →</Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { code: 'GKP', badge: 'GK', title: 'Goalkeepers', count: posCounts.GKP, sub: 'Clean sheets, saves & xGC' },
            { code: 'DEF', badge: 'DEF', title: 'Defenders', count: posCounts.DEF, sub: 'Shutouts, tackles, CBI & xGI' },
            { code: 'MID', badge: 'MID', title: 'Midfielders', count: posCounts.MID, sub: 'Goals, creativity, xA & recoveries' },
            { code: 'FWD', badge: 'FWD', title: 'Forwards', count: posCounts.FWD, sub: 'Goals, xG, threat & assists' },
          ].map((g) => (
            <Link
              key={g.code}
              href={`/players?pos=${g.code}&sort=price`}
              className="card card-hover flex flex-col justify-between gap-2"
            >
              <div className="flex items-center justify-between">
                <span className={`chip pos-${g.badge}`}>{g.badge}</span>
                <span className="text-xs font-mono text-mute">{g.count} players</span>
              </div>
              <div>
                <div className="font-semibold text-ink">{g.title}</div>
                <div className="text-xs text-mute">{g.sub}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Top movers ── */}
      {movers.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-ink">Top movers <span className="text-mute font-normal text-sm">recent</span></h2>
            <Link href="/players" className="text-sm text-accent hover:underline font-medium">View all →</Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {movers.map((m) => {
              const isUp = m.pct >= 0;
              const badge = formatPosBadge(m.position);
              return (
                <Link
                  key={m.assetId}
                  href={`/players/${m.playerId}`}
                  className="card card-hover flex items-center gap-3"
                >
                  <span className={`chip pos-${badge}`}>{badge}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-ink truncate">{m.fullName}</div>
                    <div className="text-xs text-mute">{m.clubName}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-semibold text-ink">{m.latest.toFixed(2)}</div>
                    <div className={`text-xs font-semibold font-mono ${isUp ? 'up' : 'down'}`}>
                      {isUp ? '▲' : '▼'} {Math.abs(m.pct * 100).toFixed(1)}%
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Most Valuable Players ── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-ink">Market leaders</h2>
          <Link href="/players?sort=price" className="text-sm text-accent hover:underline font-medium">View all →</Link>
        </div>
        <div className="card p-0 overflow-hidden">
          <table className="t">
            <thead>
              <tr>
                <th className="pl-4">Player</th>
                <th>Club</th>
                <th className="text-center">G</th>
                <th className="text-center">A</th>
                <th className="text-center">CS</th>
                <th className="text-center">Pts</th>
                <th className="text-right pr-4">Price</th>
              </tr>
            </thead>
            <tbody>
              {topPlayers.map((p) => (
                <tr key={p.id} className="cursor-pointer">
                  <td className="pl-4">
                    <Link href={`/players/${p.id}`} className="flex items-center gap-2 hover:text-accent transition-colors">
                      <span className={`chip pos-${p.posBucket}`}>{p.posBucket}</span>
                      <span className="font-medium">{p.fullName}</span>
                    </Link>
                  </td>
                  <td className="text-mute text-sm">{p.clubName}</td>
                  <td className="text-center font-mono font-semibold">{p.goals}</td>
                  <td className="text-center font-mono text-mute">{p.assists}</td>
                  <td className="text-center font-mono text-mute">{p.cleanSheets}</td>
                  <td className="text-center font-mono text-mute">{p.totalPoints}</td>
                  <td className="text-right pr-4 font-mono font-semibold text-accent">
                    {p.price.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how-it-works">
        <div className="text-center mb-10">
          <h2 className="text-2xl font-bold text-ink mb-2">How it works</h2>
          <p className="text-mute">Two-layer pricing. Real bonding-curve liquidity.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              step: '01',
              title: 'Layer 1 — Football Fair Value',
              body: 'Every gameweek appearance is z-scored within position group (GKP, DEF, MID, FWD), blended into a shrinkage baseline B_p and 4-match EWMA form F_p, and scaled by expected-minutes availability M_p.',
            },
            {
              step: '02',
              title: 'Layer 2 — AMM Bonding Curve',
              body: 'Market price P(q) = V · exp((q − q₀) / L) separates on-pitch fair value V from trader demand q. Every buy integrates along the curve and charges a 0.5% fee.',
            },
            {
              step: '03',
              title: 'Double-Entry Ledger',
              body: 'Every trade, quest reward, and prediction settles in minor units through a balanced double-entry ledger.',
            },
          ].map((item) => (
            <div key={item.step} className="card card-hover space-y-3">
              <span className="text-2xl font-bold text-edge font-mono">{item.step}</span>
              <h3 className="font-semibold text-ink">{item.title}</h3>
              <p className="text-sm text-mute leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
