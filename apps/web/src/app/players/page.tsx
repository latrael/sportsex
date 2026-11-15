import Link from 'next/link';
import { queryMarketPlayers } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const POS_TABS = [
  { value: 'ALL', label: 'All Positions' },
  { value: 'GKP', label: 'Goalkeepers (GK)' },
  { value: 'DEF', label: 'Defenders (DEF)' },
  { value: 'MID', label: 'Midfielders (MID)' },
  { value: 'FWD', label: 'Forwards (FWD)' },
] as const;

export default async function PlayersPage({
  searchParams,
}: {
  searchParams?: { q?: string; pos?: string; sort?: string; page?: string };
}) {
  const q = (searchParams?.q ?? '').trim();
  const rawPos = (searchParams?.pos ?? 'ALL').toUpperCase();
  const pos = rawPos === 'GK' ? 'GKP' : rawPos;
  const sort = searchParams?.sort ?? 'price';
  const page = Math.max(1, parseInt(searchParams?.page ?? '1', 10) || 1);

  const market = await queryMarketPlayers({
    q,
    pos,
    sort,
    page,
    pageSize: 50,
  });

  function buildHref(overrides: { q?: string; pos?: string; sort?: string; page?: number }) {
    const params = new URLSearchParams();
    const nextQ = overrides.q !== undefined ? overrides.q : q;
    const nextPos = overrides.pos !== undefined ? overrides.pos : pos;
    const nextSort = overrides.sort !== undefined ? overrides.sort : sort;
    const nextPage = overrides.page !== undefined ? overrides.page : 1;
    if (nextQ) params.set('q', nextQ);
    if (nextPos && nextPos !== 'ALL') params.set('pos', nextPos);
    if (nextSort) params.set('sort', nextSort);
    if (nextPage > 1) params.set('page', String(nextPage));
    const qs = params.toString();
    return qs ? `/players?${qs}` : '/players';
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-semibold">Players</h1>
        <span className="text-sm text-mute font-mono">
          {market.total.toLocaleString()} players · Page {market.page} of {market.totalPages}
        </span>
      </div>

      {/* Position-group discovery tabs (R5.4) */}
      <div className="flex gap-2 flex-wrap">
        {POS_TABS.map((tab) => {
          const active = pos === tab.value || (pos === 'ALL' && tab.value === 'ALL');
          const count = market.positionCounts[tab.value];
          return (
            <Link
              key={tab.value}
              href={buildHref({ pos: tab.value, page: 1 })}
              className={`btn text-xs ${active ? 'btn-primary' : ''}`}
            >
              {tab.label} <span className="opacity-70 ml-1">({count})</span>
            </Link>
          );
        })}
      </div>

      <form className="flex gap-2 flex-wrap" method="get" action="/players">
        <input
          className="input max-w-xs"
          name="q"
          placeholder="Search player or club (e.g. haaland)…"
          defaultValue={q}
        />
        <select className="input max-w-[160px]" name="pos" defaultValue={pos}>
          <option value="ALL">All positions</option>
          <option value="GKP">GK</option>
          <option value="DEF">DEF</option>
          <option value="MID">MID</option>
          <option value="FWD">FWD</option>
        </select>
        <select className="input max-w-[180px]" name="sort" defaultValue={sort}>
          <option value="price">Sort: Price</option>
          <option value="points">Sort: FPL Points</option>
          <option value="goals">Sort: Goals</option>
          <option value="assists">Sort: Assists</option>
          <option value="cleanSheets">Sort: Clean Sheets</option>
          <option value="saves">Sort: Saves</option>
          <option value="minutes">Sort: Minutes</option>
          <option value="name">Sort: Name</option>
        </select>
        <button className="btn btn-primary" type="submit">Apply</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="t">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th>Club</th>
              <th className="text-right">Apps</th>
              <th className="text-right">Min</th>
              <th className="text-right">G</th>
              <th className="text-right">A</th>
              <th className="text-right">CS</th>
              <th className="text-right">Saves</th>
              <th className="text-right">Pts</th>
              <th className="text-right">Price</th>
            </tr>
          </thead>
          <tbody>
            {market.items.map((p) => (
              <tr key={p.playerSeasonId} className="hover:bg-panel2">
                <td>
                  <Link className="hover:text-accent font-medium" href={`/players/${p.id}`}>
                    {p.fullName}
                  </Link>
                </td>
                <td><span className={`chip pos-${p.posBucket}`}>{p.posBucket}</span></td>
                <td className="text-mute">
                  <Link className="hover:text-accent" href={`/teams/${p.clubId}`}>
                    {p.clubName}
                  </Link>
                </td>
                <td className="text-right font-mono">{p.appearances || '—'}</td>
                <td className="text-right font-mono">{p.minutes || '—'}</td>
                <td className="text-right font-mono">{p.goals}</td>
                <td className="text-right font-mono">{p.assists}</td>
                <td className="text-right font-mono">{p.cleanSheets}</td>
                <td className="text-right font-mono">{p.saves}</td>
                <td className="text-right font-mono">{p.totalPoints}</td>
                <td className="text-right font-mono font-semibold text-accent">{p.price.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {market.items.length === 0 && <p className="text-mute text-sm p-4">No players found.</p>}
      </div>

      {/* Pagination beyond 200 rows (R5.2) */}
      {market.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          {market.page > 1 ? (
            <Link className="btn" href={buildHref({ page: market.page - 1 })}>
              ← Previous
            </Link>
          ) : (
            <span className="btn opacity-40 pointer-events-none">← Previous</span>
          )}
          <span className="text-sm text-mute font-mono">
            Showing {(market.page - 1) * market.pageSize + 1}–
            {Math.min(market.page * market.pageSize, market.total)} of {market.total}
          </span>
          {market.page < market.totalPages ? (
            <Link className="btn" href={buildHref({ page: market.page + 1 })}>
              Next →
            </Link>
          ) : (
            <span className="btn opacity-40 pointer-events-none">Next →</span>
          )}
        </div>
      )}
    </div>
  );
}
