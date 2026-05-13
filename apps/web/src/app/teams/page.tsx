import Link from 'next/link';
import { prisma } from '@/lib/db';
import { latestPricesByTeamIds } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function TeamsPage() {
  const teams = await prisma.team.findMany({ orderBy: { name: 'asc' } });
  const priceMap = await latestPricesByTeamIds(teams.map((t) => t.id));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Teams</h1>
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
