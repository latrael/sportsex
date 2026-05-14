import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { applyMatchToPrice, teamPrice as computeTeamPrice } from '@/lib/pricing';

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const EPL_LEAGUE = 39;
const SEASON = 2025;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

async function apiFetch(path: string): Promise<unknown> {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY not set');
  const r = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: { 'x-apisports-key': key },
    next: { revalidate: 0 },
  });
  if (!r.ok) throw new Error(`api-football ${r.status}: ${path}`);
  return r.json();
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const from = daysAgo(3);
  const to = daysAgo(0);

  // Fetch recently finished EPL fixtures
  const fixturesRes = await apiFetch(
    `/fixtures?league=${EPL_LEAGUE}&season=${SEASON}&status=FT&from=${from}&to=${to}`,
  ) as { response: FixtureEntry[] };

  const fixtures: FixtureEntry[] = fixturesRes.response ?? [];
  const results: { fixtureId: number; status: string }[] = [];

  // Load all teams once for matching
  const allTeams = await prisma.team.findMany();
  function findTeam(apiName: string) {
    const n = apiName.toLowerCase();
    return allTeams.find(
      (t) => t.name.toLowerCase().includes(n) || n.includes(t.name.toLowerCase()),
    ) ?? null;
  }

  for (const fx of fixtures) {
    const externalId = String(fx.fixture.id);

    // Skip already settled matches
    const existing = await prisma.match.findUnique({ where: { externalId } });
    if (existing?.status === 'settled') {
      results.push({ fixtureId: fx.fixture.id, status: 'already_settled' });
      continue;
    }

    const homeScore = fx.goals.home ?? 0;
    const awayScore = fx.goals.away ?? 0;

    // Resolve team records
    const homeTeam = findTeam(fx.teams.home.name);
    const awayTeam = findTeam(fx.teams.away.name);
    if (!homeTeam || !awayTeam) {
      results.push({ fixtureId: fx.fixture.id, status: 'team_not_found' });
      continue;
    }

    // Upsert the match record
    const match = existing
      ? await prisma.match.update({
          where: { id: existing.id },
          data: { homeScore, awayScore, status: 'finished' },
        })
      : await prisma.match.create({
          data: {
            externalId,
            homeTeamId: homeTeam.id,
            awayTeamId: awayTeam.id,
            kickoffAt: new Date(fx.fixture.date),
            status: 'finished',
            homeScore,
            awayScore,
          },
        });

    // Fetch per-player stats for this fixture
    const playersRes = await apiFetch(`/fixtures/players?fixture=${fx.fixture.id}`) as { response: FixturePlayersEntry[] };
    const fixtureTeams: FixturePlayersEntry[] = playersRes.response ?? [];

    const homeResult: 'win' | 'draw' | 'loss' = homeScore > awayScore ? 'win' : homeScore === awayScore ? 'draw' : 'loss';
    const awayResult: 'win' | 'draw' | 'loss' = awayScore > homeScore ? 'win' : awayScore === homeScore ? 'draw' : 'loss';

    await prisma.$transaction(async (tx) => {
      for (const teamEntry of fixtureTeams) {
        const isHome = teamEntry.team.id === fx.teams.home.id;
        const result = isHome ? homeResult : awayResult;
        const dbTeam = isHome ? homeTeam : awayTeam;

        for (const { player: apiPlayer, statistics } of teamEntry.players) {
          const stats = statistics[0];
          const minutes = stats?.games?.minutes ?? 0;
          if (minutes === 0) continue;

          const goals = stats?.goals?.total ?? 0;
          const assists = stats?.goals?.assists ?? 0;

          // Find matching DB player by name
          const fullName = `${apiPlayer.firstname} ${apiPlayer.lastname}`;
          const lastName = apiPlayer.lastname.toLowerCase();
          const teamPlayers = await tx.player.findMany({ where: { teamId: dbTeam.id } });
          const dbPlayer = teamPlayers.find((p) => p.fullName.toLowerCase().includes(lastName)) ?? null;
          if (!dbPlayer) continue;

          // Upsert match stat
          const existingStat = await tx.playerMatchStat.findUnique({
            where: { playerId_matchId: { playerId: dbPlayer.id, matchId: match.id } },
          });
          if (existingStat) continue;

          await tx.playerMatchStat.create({
            data: { playerId: dbPlayer.id, matchId: match.id, minutes, goals, assists, result },
          });

          // Update aggregate player stats
          await tx.player.update({
            where: { id: dbPlayer.id },
            data: {
              appearances: { increment: 1 },
              minutes: { increment: minutes },
              goals: { increment: goals },
              assists: { increment: assists },
            },
          });

          // New price valuation
          const lastVal = await tx.valuation.findFirst({
            where: { playerId: dbPlayer.id },
            orderBy: { computedAt: 'desc' },
          });
          const newPrice = applyMatchToPrice(lastVal?.price ?? 50, { goals, assists, minutes, result });
          await tx.valuation.create({
            data: {
              playerId: dbPlayer.id,
              price: newPrice,
              basePrice: newPrice,
              demandMult: lastVal?.demandMult ?? 1,
              matchId: match.id,
            },
          });
        }

        // Recompute team price
        const players = await tx.player.findMany({ where: { teamId: dbTeam.id } });
        const prices: { price: number; minutes: number }[] = [];
        for (const p of players) {
          const v = await tx.valuation.findFirst({ where: { playerId: p.id }, orderBy: { computedAt: 'desc' } });
          if (v) prices.push({ price: v.price, minutes: p.minutes });
        }
        const pts = result === 'win' ? 3 : result === 'draw' ? 1 : 0;
        const tp = computeTeamPrice(prices, pts);
        await tx.valuation.create({
          data: { teamId: dbTeam.id, price: tp, basePrice: tp, demandMult: 1, matchId: match.id },
        });
      }

      await tx.match.update({ where: { id: match.id }, data: { status: 'settled', settledAt: new Date() } });
    }, { timeout: 60_000 });

    // Settle predictions
    const winningPick = homeResult === 'win' ? 'H' : awayResult === 'win' ? 'A' : 'D';
    const preds = await prisma.prediction.findMany({ where: { matchId: match.id, resolved: false } });
    for (const p of preds) {
      const payout = p.pick === winningPick ? p.coinsStaked * 2 : 0;
      await prisma.prediction.update({ where: { id: p.id }, data: { resolved: true, payout } });
      if (payout > 0) {
        await prisma.user.update({ where: { id: p.userId }, data: { coinBalance: { increment: payout } } });
        await prisma.transaction.create({
          data: { userId: p.userId, assetKind: 'prediction_payout', side: 'credit', coinsDelta: payout, reason: `match_${match.id}` },
        });
      }
    }

    results.push({ fixtureId: fx.fixture.id, status: 'settled' });
  }

  return NextResponse.json({ ok: true, processed: results.length, results });
}

// Types -----------------------------------------------------------------------

interface FixtureEntry {
  fixture: { id: number; date: string };
  teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  goals: { home: number | null; away: number | null };
}

interface FixturePlayersEntry {
  team: { id: number };
  players: {
    player: { id: number; firstname: string; lastname: string };
    statistics: { games?: { minutes?: number }; goals?: { total?: number; assists?: number } }[];
  }[];
}
