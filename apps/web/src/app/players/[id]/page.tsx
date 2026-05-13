import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import PriceChart from '@/components/PriceChart';
import TradeWidget from '@/components/TradeWidget';
import ReportButton from '@/components/ReportButton';
import Link from 'next/link';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

export default async function PlayerDetail({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  if (!Number.isFinite(id)) notFound();

  const player = await prisma.player.findUnique({
    where: { id },
    include: { team: true },
  });
  if (!player) notFound();

  const valuations = await prisma.valuation.findMany({
    where: { playerId: id },
    orderBy: { computedAt: 'asc' },
    take: 200,
  });
  const latest = valuations[valuations.length - 1]?.price ?? 50;

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const me = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  const holding = userId
    ? await prisma.holding.findFirst({
        where: { userId, assetKind: 'player', assetId: id },
      })
    : null;

  const comments = await prisma.comment.findMany({
    where: { playerId: id, status: 'visible' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { user: true },
  });

  async function postComment(formData: FormData) {
    'use server';
    if (!userId) return;
    const body = String(formData.get('body') ?? '').trim().slice(0, 500);
    if (!body) return;
    // tiny word filter
    const banned = ['fuck', 'shit', 'bitch'];
    const lc = body.toLowerCase();
    const flagged = banned.some((w) => lc.includes(w));
    await prisma.comment.create({
      data: { userId, playerId: id, body, status: flagged ? 'flagged' : 'visible' },
    });
    revalidatePath(`/players/${id}`);
  }

  const chartData = valuations.map((v) => ({
    t: new Date(v.computedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    price: Math.round(v.price * 100) / 100,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`chip pos-${player.posBucket ?? 'OTHER'}`}>{player.posBucket}</span>
            <span className="chip">{player.position}</span>
          </div>
          <h1 className="text-3xl font-bold">{player.fullName}</h1>
          <p className="text-mute">
            {player.team ? <Link className="hover:text-accent" href={`/teams/${player.team.id}`}>{player.team.name}</Link> : '—'}
            {player.nationality ? ` · ${player.nationality}` : ''}
          </p>
        </div>
        <div className="card text-right">
          <div className="text-xs text-mute uppercase">Current price</div>
          <div className="text-3xl font-bold font-mono">{latest.toFixed(2)}</div>
          <div className="text-xs text-mute mt-1">Float {(player.totalShares - player.sharesHeld)} / {player.totalShares}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card">
          <PriceChart data={chartData} />
          <div className="grid grid-cols-4 gap-4 mt-4 text-center">
            <div><div className="text-xs text-mute">Apps</div><div className="font-mono">{player.appearances}</div></div>
            <div><div className="text-xs text-mute">Minutes</div><div className="font-mono">{player.minutes}</div></div>
            <div><div className="text-xs text-mute">Goals</div><div className="font-mono">{player.goals}</div></div>
            <div><div className="text-xs text-mute">Assists</div><div className="font-mono">{player.assists}</div></div>
          </div>
        </div>

        <TradeWidget
          assetKind="player"
          assetId={player.id}
          price={latest}
          signedIn={!!userId}
          ownedShares={holding?.shares ?? 0}
          balance={me?.coinBalance ?? 0}
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
