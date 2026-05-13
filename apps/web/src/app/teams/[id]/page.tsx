import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import PriceChart from '@/components/PriceChart';
import TradeWidget from '@/components/TradeWidget';
import Link from 'next/link';
import { latestPricesByPlayerIds } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function TeamDetail({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) notFound();
  const team = await prisma.team.findUnique({
    where: { id },
    include: { players: true },
  });
  if (!team) notFound();

  const valuations = await prisma.valuation.findMany({
    where: { teamId: id },
    orderBy: { computedAt: 'asc' },
    take: 200,
  });
  const latest = valuations[valuations.length - 1]?.price ?? 50;

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const me = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  const holding = userId
    ? await prisma.holding.findFirst({ where: { userId, assetKind: 'team', assetId: id } })
    : null;

  const playerPriceMap = await latestPricesByPlayerIds(team.players.map((p) => p.id));
  const roster = [...team.players].sort((a, b) => b.minutes - a.minutes);

  const chartData = valuations.map((v) => ({
    t: new Date(v.computedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    price: Math.round(v.price * 100) / 100,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{team.name}</h1>
          <p className="text-mute">{team.league} · {team.players.length} players</p>
        </div>
        <div className="card text-right">
          <div className="text-xs text-mute uppercase">Team price</div>
          <div className="text-3xl font-bold font-mono">{latest.toFixed(2)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card">
          <PriceChart data={chartData} />
        </div>
        <TradeWidget
          assetKind="team"
          assetId={team.id}
          price={latest}
          signedIn={!!userId}
          ownedShares={holding?.shares ?? 0}
          balance={me?.coinBalance ?? 0}
        />
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Roster</h2>
        <div className="card overflow-x-auto">
          <table className="t">
            <thead>
              <tr><th>Player</th><th>Pos</th><th className="text-right">G</th><th className="text-right">A</th><th className="text-right">Min</th><th className="text-right">Price</th></tr>
            </thead>
            <tbody>
              {roster.map((p) => (
                <tr key={p.id} className="hover:bg-panel2">
                  <td><Link className="hover:text-accent" href={`/players/${p.id}`}>{p.fullName}</Link></td>
                  <td><span className={`chip pos-${p.posBucket ?? 'OTHER'}`}>{p.posBucket}</span></td>
                  <td className="text-right font-mono">{p.goals}</td>
                  <td className="text-right font-mono">{p.assists}</td>
                  <td className="text-right font-mono">{p.minutes}</td>
                  <td className="text-right font-mono">{(playerPriceMap.get(p.id) ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
