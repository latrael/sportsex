import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import PriceChart from '@/components/PriceChart';
import TradeWidget from '@/components/TradeWidget';
import ReportButton from '@/components/ReportButton';
import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { getMarketPlayerDetail, priceHistoryForAsset } from '@/lib/queries';
import { getOrInitUserBalanceMinor, DEFAULT_FLOAT_SHARES } from '@/lib/market';
import { minorUnitsToCoinsDecimal } from '@/lib/money';

export const dynamic = 'force-dynamic';

export default async function PlayerDetail({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) notFound();

  const player = await getMarketPlayerDetail(id);
  if (!player) notFound();

  const history = player.assetId
    ? await priceHistoryForAsset(player.assetId, 200)
    : [{ t: 'Seed', computedAt: new Date(), price: player.price, fairValue: player.fairValue, source: 'SEED' }];

  const chartData =
    history.length > 0
      ? history.map((h) => ({
          t: h.t,
          price: Math.round(h.price * 100) / 100,
        }))
      : [{ t: 'Current', price: Math.round(player.price * 100) / 100 }];

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const me = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;

  const [position, balanceMinor, comments] = await Promise.all([
    userId && player.assetId
      ? prisma.position.findUnique({
          where: { userId_assetId: { userId, assetId: player.assetId } },
        })
      : Promise.resolve(null),
    userId && me
      ? getOrInitUserBalanceMinor(prisma, userId, me.coinBalance)
      : Promise.resolve(0n),
    prisma.comment.findMany({
      where: { playerId: player.id, status: 'visible' },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: true },
    }),
  ]);

  const balanceCoins = Number(minorUnitsToCoinsDecimal(balanceMinor));

  async function postComment(formData: FormData) {
    'use server';
    if (!userId || !player) return;
    const body = String(formData.get('body') ?? '').trim().slice(0, 500);
    if (!body) return;
    const banned = ['fuck', 'shit', 'bitch'];
    const lc = body.toLowerCase();
    const flagged = banned.some((w) => lc.includes(w));
    await prisma.comment.create({
      data: { userId, playerId: player.id, body, status: flagged ? 'flagged' : 'visible' },
    });
    revalidatePath(`/players/${player.id}`);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`chip pos-${player.posBucket}`}>{player.posBucket}</span>
            <span className="chip">{player.position}</span>
          </div>
          <h1 className="text-3xl font-bold">{player.fullName}</h1>
          <p className="text-mute">
            <Link className="hover:text-accent" href={`/teams/${player.clubId}`}>
              {player.clubName}
            </Link>
          </p>
        </div>
        <div className="card text-right">
          <div className="text-xs text-mute uppercase">Market price</div>
          <div className="text-3xl font-bold font-mono">{player.price.toFixed(2)}</div>
          <div className="text-xs text-mute mt-1">
            Fair value {player.fairValue.toFixed(2)} · Float {DEFAULT_FLOAT_SHARES - player.inventory} / {DEFAULT_FLOAT_SHARES}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card">
          <PriceChart data={chartData} />
          <div className="grid grid-cols-6 gap-4 mt-4 text-center">
            <div><div className="text-xs text-mute">Apps</div><div className="font-mono">{player.appearances || '—'}</div></div>
            <div><div className="text-xs text-mute">Minutes</div><div className="font-mono">{player.minutes || '—'}</div></div>
            <div><div className="text-xs text-mute">Goals</div><div className="font-mono">{player.goals}</div></div>
            <div><div className="text-xs text-mute">Assists</div><div className="font-mono">{player.assists}</div></div>
            <div><div className="text-xs text-mute">Clean sheets</div><div className="font-mono">{player.cleanSheets}</div></div>
            <div><div className="text-xs text-mute">FPL Pts</div><div className="font-mono">{player.totalPoints}</div></div>
          </div>
        </div>

        <TradeWidget
          assetKind="player"
          assetId={player.id}
          price={player.price}
          fairValue={player.fairValue}
          inventory={player.inventory}
          seedInventory={player.seedInventory}
          liquidity={player.liquidity}
          signedIn={!!userId}
          ownedShares={position?.shares ?? 0}
          balance={balanceCoins}
          stats={[
            { label: 'Apps', value: player.appearances || '—' },
            { label: 'Minutes', value: player.minutes || '—' },
            { label: 'Goals', value: player.goals },
            { label: 'Assists', value: player.assists },
            { label: 'Clean sheets', value: player.cleanSheets },
            { label: 'Saves', value: player.saves },
          ]}
        />
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Takes</h2>
        {userId ? (
          <form action={postComment} className="card mb-3 flex gap-2">
            <input className="input" name="body" placeholder="Share your take…" maxLength={500} required />
            <button className="btn btn-primary" type="submit">Post</button>
          </form>
        ) : (
          <p className="text-mute text-sm mb-3">Sign in to post a take.</p>
        )}
        <div className="space-y-2">
          {comments.length === 0 && <p className="text-mute text-sm">No takes yet.</p>}
          {comments.map((c) => (
            <div key={c.id} className="card">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-mute">
                  @{c.user.handle} · {new Date(c.createdAt).toLocaleString()}
                </div>
                {userId && userId !== c.userId && <ReportButton commentId={c.id} />}
              </div>
              <p className="mt-1 text-sm">{c.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
