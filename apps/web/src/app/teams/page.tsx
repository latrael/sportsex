import Link from 'next/link';
import { queryMarketClubs } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function TeamsPage({
  searchParams,
}: {
  searchParams?: { sort?: string };
}) {
  const sort = searchParams?.sort ?? 'name';
  const clubs = await queryMarketClubs(sort);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Teams</h1>
      <form className="flex gap-2" method="get">
        <select className="input max-w-[140px]" name="sort" defaultValue={sort}>
          <option value="name">Sort: Name</option>
          <option value="price">Sort: Price</option>
        </select>
        <button className="btn" type="submit">Apply</button>
      </form>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {clubs.map((c) => (
          <Link key={c.id} href={`/teams/${c.id}`} className="card hover:border-accent flex justify-between items-center">
            <div>
              <div className="font-medium">{c.name}</div>
              <div className="text-xs text-mute">{c.shortName} · {c.playerCount} players</div>
            </div>
            <div className="font-mono font-semibold text-accent">{c.price.toFixed(2)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
