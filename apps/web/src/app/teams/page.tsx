import Link from 'next/link';
import { prisma } from '@/lib/db';
import { latestPricesByTeamIds } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function TeamsPage({
  searchParams,
}: {
  searchParams?: { sort?: string };
}) {
  const sort = searchParams?.sort ?? 'name';

  const teamsRaw = await prisma.team.findMany({ orderBy: { name: 'asc' } });
  const priceMap = await latestPricesByTeamIds(teamsRaw.map((t) => t.id));
  const teams =
    sort === 'price'
      ? [...teamsRaw].sort((a, b) => (priceMap.get(b.id) ?? 0) - (priceMap.get(a.id) ?? 0))
      : teamsRaw;

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
        {teams.map((t) => (
          <Link key={t.id} href={`/teams/${t.id}`} className="card hover:border-accent flex justify-between items-center">
            <div className="font-medium">{t.name}</div>
            <div className="font-mono">{(priceMap.get(t.id) ?? 0).toFixed(2)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
