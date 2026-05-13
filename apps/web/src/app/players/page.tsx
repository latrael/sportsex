import Link from 'next/link';
import { prisma } from '@/lib/db';
import { latestPricesByPlayerIds } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function PlayersPage({
  searchParams,
}: {
  searchParams?: { q?: string; pos?: string; sort?: string };
}) {
  const q = (searchParams?.q ?? '').trim();
  const pos = searchParams?.pos;
  const sort = searchParams?.sort ?? 'goals';

  const where: Record<string, unknown> = {};
  if (q) where.fullName = { contains: q };
  if (pos && pos !== 'ALL') where.posBucket = pos;

  const players = await prisma.player.findMany({
    where,
    include: { team: true },
    orderBy:
      sort === 'name'
        ? { fullName: 'asc' }
        : sort === 'minutes'
        ? { minutes: 'desc' }
        : sort === 'assists'
        ? { assists: 'desc' }
        : { goals: 'desc' },
    take: 200,
  });
  const priceMap = await latestPricesByPlayerIds(players.map((p) => p.id));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Players</h1>
      <form className="flex gap-2 flex-wrap" method="get">
        <input className="input max-w-xs" name="q" placeholder="Search…" defaultValue={q} />
        <select className="input max-w-[140px]" name="pos" defaultValue={pos ?? 'ALL'}>
          <option value="ALL">All positions</option>
          <option value="GK">GK</option>
          <option value="DEF">DEF</option>
          <option value="MID">MID</option>
          <option value="FWD">FWD</option>
        </select>
        <select className="input max-w-[140px]" name="sort" defaultValue={sort}>
          <option value="goals">Sort: Goals</option>
          <option value="assists">Sort: Assists</option>
          <option value="minutes">Sort: Minutes</option>
          <option value="name">Sort: Name</option>
        </select>
        <button className="btn" type="submit">Apply</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="t">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th className="text-right">G</th>
              <th className="text-right">A</th>
              <th className="text-right">Min</th>
              <th className="text-right">Price</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id} className="hover:bg-panel2">
                <td><Link className="hover:text-accent" href={`/players/${p.id}`}>{p.fullName}</Link></td>
                <td><span className={`chip pos-${p.posBucket ?? 'OTHER'}`}>{p.posBucket}</span></td>
                <td className="text-mute">{p.team?.name}</td>
                <td className="text-right font-mono">{p.goals}</td>
                <td className="text-right font-mono">{p.assists}</td>
                <td className="text-right font-mono">{p.minutes}</td>
                <td className="text-right font-mono">{(priceMap.get(p.id) ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {players.length === 0 && <p className="text-mute text-sm">No players found.</p>}
      </div>
    </div>
  );
}
