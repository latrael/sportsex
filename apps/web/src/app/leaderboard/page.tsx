import { prisma } from '@/lib/db';
import { getLeaderboardRankings } from '@/lib/market';
import { auth } from '@/lib/auth';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams?: { lb?: string };
}) {
  const session = await auth();
  const myId = (session?.user as { id?: string } | undefined)?.id;

  const lbId = searchParams?.lb ? parseInt(searchParams.lb, 10) : null;
  let scopedUserIds: string[] | null = null;
  let lbName = 'Global';
  if (lbId) {
    const lb = await prisma.privateLeaderboard.findUnique({
      where: { id: lbId },
      include: { members: true },
    });
    if (lb) {
      lbName = lb.name;
      scopedUserIds = [lb.ownerId, ...lb.members.map((m) => m.userId)];
    }
  }

  const ranked = await getLeaderboardRankings(scopedUserIds);

  const myLbs = myId
    ? await prisma.privateLeaderboard.findMany({
        where: {
          OR: [{ ownerId: myId }, { members: { some: { userId: myId } } }],
        },
      })
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">{lbName} leaderboard</h1>
        <Link href="/leaderboard" className={`btn ${!lbId ? 'btn-primary' : ''}`}>Global</Link>
        {myLbs.map((lb) => (
          <Link key={lb.id} href={`/leaderboard?lb=${lb.id}`} className={`btn ${lbId === lb.id ? 'btn-primary' : ''}`}>{lb.name}</Link>
        ))}
        {myId && <Link href="/friends" className="btn">Manage groups</Link>}
      </div>
      <div className="card overflow-x-auto">
        <table className="t">
          <thead>
            <tr>
              <th>#</th>
              <th>User</th>
              <th className="text-right">Cash</th>
              <th className="text-right">Positions value</th>
              <th className="text-right">Net worth</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => (
              <tr key={r.user.id} className={r.user.id === myId ? 'bg-panel2' : ''}>
                <td className="font-mono">{i + 1}</td>
                <td>@{r.user.handle}</td>
                <td className="text-right font-mono">{r.cashBalance.toFixed(2)}</td>
                <td className="text-right font-mono">{r.holdingsValue.toFixed(2)}</td>
                <td className="text-right font-mono font-semibold text-accent">{r.netWorth.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {ranked.length === 0 && <p className="text-mute text-sm">No users yet.</p>}
      </div>
    </div>
  );
}
