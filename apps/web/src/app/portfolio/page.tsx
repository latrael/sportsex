import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getUserPortfolioSummary } from '@/lib/market';
import { minorUnitsToCoinsDecimal } from '@/lib/money';
import { LedgerAccount } from '@prisma/client';

export const dynamic = 'force-dynamic';

export default async function Portfolio() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const [summary, ledgerEntries, pendingPredictions] = await Promise.all([
    getUserPortfolioSummary(userId),
    prisma.ledgerEntry.findMany({
      where: { userId, account: LedgerAccount.USER_CASH },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30,
      include: {
        trade: {
          include: {
            asset: {
              include: {
                playerSeason: { include: { player: true } },
                clubSeason: { include: { club: true } },
              },
            },
          },
        },
      },
    }),
    prisma.prediction.findMany({
      where: { userId, resolved: false },
      include: {
        fixture: {
          include: {
            homeClub: { include: { club: true } },
            awayClub: { include: { club: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const { cashBalance, holdingsValue, netWorth, pnl, pnlPct, positions } = summary;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="card">
          <div className="text-mute text-xs uppercase">Cash balance (ledger)</div>
          <div className="font-mono text-2xl">{cashBalance.toFixed(2)}</div>
        </div>
        <div className="card">
          <div className="text-mute text-xs uppercase">Holdings value</div>
          <div className="font-mono text-2xl">{holdingsValue.toFixed(2)}</div>
        </div>
        <div className="card">
          <div className="text-mute text-xs uppercase">Net worth</div>
          <div className="font-mono text-2xl">{netWorth.toFixed(2)}</div>
        </div>
        <div className="card">
          <div className="text-mute text-xs uppercase">Unrealised PnL</div>
          <div className={`font-mono text-2xl ${pnl >= 0 ? 'up' : 'down'}`}>
            {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)} ({pnlPct.toFixed(1)}%)
          </div>
        </div>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Positions</h2>
        {positions.length === 0 ? (
          <p className="text-mute text-sm">
            No positions yet. <Link className="text-accent" href="/players">Browse players</Link>.
          </p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="t">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Kind</th>
                  <th className="text-right">Shares</th>
                  <th className="text-right">Avg cost</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">PnL</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((r) => {
                  const href = r.assetKind === 'player' ? `/players/${r.targetId}` : `/teams/${r.targetId}`;
                  return (
                    <tr key={r.positionId}>
                      <td>
                        <Link className="hover:text-accent font-medium" href={href}>
                          {r.name}
                        </Link>
                        <span className="text-xs text-mute ml-2">{r.subtitle}</span>
                      </td>
                      <td><span className="chip">{r.assetKind}</span></td>
                      <td className="text-right font-mono">{r.shares}</td>
                      <td className="text-right font-mono">{r.avgCost.toFixed(2)}</td>
                      <td className="text-right font-mono">{r.price.toFixed(2)}</td>
                      <td className="text-right font-mono">{r.value.toFixed(2)}</td>
                      <td className={`text-right font-mono ${r.pnl >= 0 ? 'up' : 'down'}`}>
                        {r.pnl >= 0 ? '+' : ''}{r.pnl.toFixed(2)}
                      </td>
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
                <tr>
                  <th>Fixture</th>
                  <th>Pick</th>
                  <th className="text-right">Odds</th>
                  <th className="text-right">Staked</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pendingPredictions.map((p) => {
                  const homeName = p.fixture.homeClub.club.name;
                  const awayName = p.fixture.awayClub.club.name;
                  return (
                    <tr key={p.id}>
                      <td className="text-sm">{homeName} vs {awayName}</td>
                      <td>
                        <span className="chip">
                          {p.pick === 'H' ? `${homeName} win` : p.pick === 'A' ? `${awayName} win` : 'Draw'}
                        </span>
                      </td>
                      <td className="text-right font-mono">{Number(p.odds).toFixed(2)}×</td>
                      <td className="text-right font-mono">{p.coinsStaked}</td>
                      <td><span className="text-mute text-xs">Pending</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-3">Ledger activity</h2>
        <div className="card overflow-x-auto">
          <table className="t">
            <thead>
              <tr>
                <th>When</th>
                <th>Reason</th>
                <th>Instrument</th>
                <th className="text-right">Shares</th>
                <th className="text-right">Avg Price</th>
                <th className="text-right">Cash Delta</th>
              </tr>
            </thead>
            <tbody>
              {ledgerEntries.map((entry) => {
                const coinsDelta = Number(minorUnitsToCoinsDecimal(entry.amount));
                const tr = entry.trade;
                const assetName = tr?.asset.playerSeason
                  ? `${tr.asset.playerSeason.player.firstName} ${tr.asset.playerSeason.player.secondName}`
                  : tr?.asset.clubSeason
                  ? tr.asset.clubSeason.club.name
                  : '—';
                return (
                  <tr key={entry.id}>
                    <td className="text-mute">{new Date(entry.createdAt).toLocaleString()}</td>
                    <td><span className="chip">{entry.reason}</span></td>
                    <td className="text-sm">{assetName}</td>
                    <td className="text-right font-mono">{tr ? tr.shares : '—'}</td>
                    <td className="text-right font-mono">{tr ? Number(tr.avgPrice).toFixed(2) : '—'}</td>
                    <td className={`text-right font-mono ${coinsDelta >= 0 ? 'up' : 'down'}`}>
                      {coinsDelta >= 0 ? '+' : ''}{coinsDelta.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {ledgerEntries.length === 0 && <p className="text-mute text-sm p-3">No ledger activity yet.</p>}
        </div>
      </section>
    </div>
  );
}
