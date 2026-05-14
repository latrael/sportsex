import Link from 'next/link';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { latestPricesByPlayerIds, topMovers } from '@/lib/queries';

export default async function Home() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;

  const [playerCount, teamCount, txCount, topPlayers, movers] = await Promise.all([
    prisma.player.count(),
    prisma.team.count(),
    prisma.transaction.count({ where: { side: { in: ['buy', 'sell'] } } }),
    prisma.player.findMany({
      take: 12,
      orderBy: [{ goals: 'desc' }, { assists: 'desc' }],
      include: { team: true },
    }),
    topMovers(6),
  ]);

  const priceMap = await latestPricesByPlayerIds(topPlayers.map((p) => p.id));
  const moverPlayers = await prisma.player.findMany({
    where: { id: { in: movers.map((m) => m.playerId) } },
    include: { team: true },
  });
  const byId = new Map(moverPlayers.map((p) => [p.id, p]));

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
            A virtual stock market for EPL players and teams. Prices move with on-pitch performance
            and real trading pressure. No real money — just bragging rights.
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
            { label: 'Teams', value: teamCount.toString() },
            { label: 'Trades placed', value: txCount.toLocaleString() },
          ].map((s) => (
            <div key={s.label} className="px-4 py-3 rounded-xl bg-white/10 border border-white/20 backdrop-blur-sm text-right min-w-[140px]">
              <div className="text-white/60 text-xs font-medium">{s.label}</div>
              <div className="text-white text-2xl font-bold font-mono">{s.value}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how-it-works">
        <div className="text-center mb-10">
          <h2 className="text-2xl font-bold text-ink mb-2">How it works</h2>
          <p className="text-mute">Three steps. No real money. Pure sports conviction.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              step: '01',
              title: 'Get your coins',
              body: 'Sign up and receive 10,000 virtual coins instantly. Earn more through daily quests, predictions, and on-pitch performance from your picks.',
              icon: (
                <svg className="w-6 h-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33" />
                </svg>
              ),
            },
            {
              step: '02',
              title: 'Pick your players',
              body: 'Browse 560+ EPL players and 21 teams. Buy shares at the current market price. The fewer shares in circulation, the more scarce — and potentially valuable — yours become.',
              icon: (
                <svg className="w-6 h-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
                </svg>
              ),
            },
            {
              step: '03',
              title: 'Watch prices move',
              body: 'Prices update on every trade (supply and demand) and after every match (goals, assists, result). Sell when you\'re up. Hold if you believe. The market never sleeps.',
              icon: (
                <svg className="w-6 h-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18 9 11.25l4.306 4.306a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.281m5.94 2.28-2.28 5.941" />
                </svg>
              ),
            },
          ].map((item) => (
            <div key={item.step} className="card card-hover space-y-4">
              <div className="flex items-center justify-between">
                <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
                  {item.icon}
                </div>
                <span className="text-3xl font-bold text-edge font-mono">{item.step}</span>
              </div>
              <div>
                <h3 className="font-semibold text-ink mb-1">{item.title}</h3>
                <p className="text-sm text-mute leading-relaxed">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Algorithm ── */}
      <section className="card space-y-6">
        <div>
          <h2 className="text-xl font-bold text-ink mb-1">How prices are calculated</h2>
          <p className="text-sm text-mute">Transparent by design. No black boxes.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            {
              label: 'Seed price',
              color: 'bg-violet-50 border-violet-100',
              labelColor: 'text-violet-600',
              formula: 'base = 50 + goals×5 + assists×3\n      + min(minutes/1000, 3)×10\n      + projection×20',
              desc: 'Starting price set from season stats and projected performance. Clamped between 5 and 2,000 coins.',
            },
            {
              label: 'Demand multiplier',
              color: 'bg-blue-50 border-blue-100',
              labelColor: 'text-blue-600',
              formula: 'mult = clamp(\n  1 + 0.0005 × net_buys_24h,\n  0.7, 1.5\n)',
              desc: 'Every buy pushes the price up; every sell pushes it down. Effect fades as trades age past 24 hours.',
            },
            {
              label: 'Match settle',
              color: 'bg-green-50 border-green-100',
              labelColor: 'text-green-700',
              formula: 'pts = goals×8 + assists×5\n    + (mins≥60 ? 1 : 0)\nresult = win+2, draw+0, loss−2\nnewPrice = last × (1 + pts/100)',
              desc: 'After every match, prices shift permanently based on performance. A hat-trick in a win moves the needle.',
            },
          ].map((block) => (
            <div key={block.label} className={`rounded-xl border p-4 space-y-3 ${block.color}`}>
              <span className={`text-xs font-bold uppercase tracking-widest ${block.labelColor}`}>{block.label}</span>
              <pre className="text-xs font-mono text-ink/80 leading-relaxed whitespace-pre-wrap bg-white/60 rounded-lg p-3 border border-white/80">
                {block.formula}
              </pre>
              <p className="text-xs text-mute leading-relaxed">{block.desc}</p>
            </div>
          ))}
        </div>

        <div className="flex items-start gap-3 p-3 bg-panel2 rounded-lg border border-edge text-sm text-mute">
          <svg className="w-4 h-4 text-accent shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
          <span>
            Team prices are the average of the 11 most-played players on the roster, plus a form bonus
            (up to +36 coins for a perfect 6-match run). The full algorithm lives in{' '}
            <code className="font-mono text-xs bg-edge/40 px-1 rounded">apps/web/src/lib/pricing.ts</code> — one file, fully swappable.
          </span>
        </div>
      </section>

      {/* ── Top movers ── */}
      {movers.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-ink">Top movers <span className="text-mute font-normal text-sm">24h</span></h2>
            <Link href="/players" className="text-sm text-accent hover:underline font-medium">View all →</Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {movers.map((m) => {
              const p = byId.get(m.playerId);
              if (!p) return null;
              const isUp = m.pct >= 0;
              return (
                <Link
                  key={m.playerId}
                  href={`/players/${p.id}`}
                  className="card card-hover flex items-center gap-3"
                >
                  <span className={`chip pos-${p.posBucket ?? 'OTHER'}`}>{p.posBucket}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-ink truncate">{p.fullName}</div>
                    <div className="text-xs text-mute">{p.team?.name}</div>
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

      {/* ── Top scorers ── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-ink">Top performers</h2>
          <Link href="/players" className="text-sm text-accent hover:underline font-medium">View all →</Link>
        </div>
        <div className="card p-0 overflow-hidden">
          <table className="t">
            <thead>
              <tr>
                <th className="pl-4">Player</th>
                <th>Team</th>
                <th className="text-center">G</th>
                <th className="text-center">A</th>
                <th className="text-right pr-4">Price</th>
              </tr>
            </thead>
            <tbody>
              {topPlayers.map((p) => (
                <tr key={p.id} className="cursor-pointer">
                  <td className="pl-4">
                    <Link href={`/players/${p.id}`} className="flex items-center gap-2 hover:text-accent transition-colors">
                      <span className={`chip pos-${p.posBucket ?? 'OTHER'}`}>{p.posBucket}</span>
                      <span className="font-medium">{p.fullName}</span>
                    </Link>
                  </td>
                  <td className="text-mute text-sm">{p.team?.name ?? '—'}</td>
                  <td className="text-center font-mono font-semibold">{p.goals}</td>
                  <td className="text-center font-mono text-mute">{p.assists}</td>
                  <td className="text-right pr-4 font-mono font-semibold text-accent">
                    {(priceMap.get(p.id) ?? 0).toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

    </div>
  );
}
