import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import PriceChart from '@/components/PriceChart';
import TradeWidget from '@/components/TradeWidget';
import Link from 'next/link';
import { getMarketClubDetail, priceHistoryForAsset } from '@/lib/queries';
import { getOrInitUserBalanceMinor } from '@/lib/market';
import { minorUnitsToCoinsDecimal } from '@/lib/money';

export const dynamic = 'force-dynamic';

export default async function TeamDetail({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) notFound();

  const detail = await getMarketClubDetail(id);
  if (!detail) notFound();
  const { club, roster } = detail;

  const history = club.assetId
    ? await priceHistoryForAsset(club.assetId, 200)
    : [{ t: 'Seed', computedAt: new Date(), price: club.price, fairValue: club.fairValue, source: 'SEED' }];

  const chartData =
    history.length > 0
      ? history.map((h) => ({
          t: h.t,
          price: Math.round(h.price * 100) / 100,
        }))
      : [{ t: 'Current', price: Math.round(club.price * 100) / 100 }];

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const me = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;

  const [position, balanceMinor] = await Promise.all([
    userId && club.assetId
      ? prisma.position.findUnique({
          where: { userId_assetId: { userId, assetId: club.assetId } },
        })
      : Promise.resolve(null),
    userId && me
      ? getOrInitUserBalanceMinor(prisma, userId, me.coinBalance)
      : Promise.resolve(0n),
  ]);

  const balanceCoins = Number(minorUnitsToCoinsDecimal(balanceMinor));

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{club.name}</h1>
          <p className="text-mute">EPL · {club.shortName} · {roster.length} players</p>
        </div>
        <div className="card text-right">
          <div className="text-xs text-mute uppercase">Club price</div>
          <div className="text-3xl font-bold font-mono">{club.price.toFixed(2)}</div>
          <div className="text-xs text-mute mt-1">Fair value {club.fairValue.toFixed(2)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card">
          <PriceChart data={chartData} />
        </div>
        <TradeWidget
          assetKind="team"
          assetId={club.id}
          price={club.price}
          fairValue={club.fairValue}
          inventory={club.inventory}
          seedInventory={club.seedInventory}
          liquidity={club.liquidity}
          signedIn={!!userId}
          ownedShares={position?.shares ?? 0}
          balance={balanceCoins}
        />
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Roster</h2>
        <div className="card overflow-x-auto">
          <table className="t">
            <thead>
              <tr>
                <th>Player</th>
                <th>Pos</th>
                <th className="text-right">Apps</th>
                <th className="text-right">Min</th>
                <th className="text-right">G</th>
                <th className="text-right">A</th>
                <th className="text-right">CS</th>
                <th className="text-right">Pts</th>
                <th className="text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((p) => (
                <tr key={p.playerSeasonId} className="hover:bg-panel2">
                  <td><Link className="hover:text-accent font-medium" href={`/players/${p.id}`}>{p.fullName}</Link></td>
                  <td><span className={`chip pos-${p.posBucket}`}>{p.posBucket}</span></td>
                  <td className="text-right font-mono">{p.appearances || '—'}</td>
                  <td className="text-right font-mono">{p.minutes || '—'}</td>
                  <td className="text-right font-mono">{p.goals}</td>
                  <td className="text-right font-mono">{p.assists}</td>
                  <td className="text-right font-mono">{p.cleanSheets}</td>
                  <td className="text-right font-mono">{p.totalPoints}</td>
                  <td className="text-right font-mono font-semibold text-accent">{p.price.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
