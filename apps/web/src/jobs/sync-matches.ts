// sync-matches.ts — settle player and team prices for newly finished PL matches.
// Run from apps/web: npx tsx --env-file=.env src/jobs/sync-matches.ts
//
// Uses one bulk API call to football-data.org — no per-match requests, no rate-limit delays.
// Prices move on win/draw/loss result only. For player goals/assists, run update-player-stats.ts.
//
// Requires: FOOTBALL_DATA_API_KEY in .env  (free at football-data.org)
// Requires: DATABASE_URL in .env

import { PrismaClient } from '@prisma/client';
import { canonName } from '../lib/canon';
import { applyMatchToPrice, teamPrice, MatchPerf } from '../lib/pricing';

const prisma = new PrismaClient();
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BASE = 'https://api.football-data.org/v4';

if (!API_KEY) {
  console.error('FOOTBALL_DATA_API_KEY is not set. Get a free key at football-data.org.');
  process.exit(1);
}

type FdoMatch = {
  id: number;
  utcDate: string;
  homeTeam: { name: string; shortName: string; tla: string };
  awayTeam: { name: string; shortName: string; tla: string };
  score: { fullTime: { home: number | null; away: number | null } };
};

async function fdoGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Auth-Token': API_KEY! } });
  if (!res.ok) throw new Error(`FDO ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

// Cache teams to avoid repeated DB lookups per match
let teamCache: Array<{ id: number; name: string }> | null = null;
async function resolveTeam(fdoName: string, fdoShort: string) {
  if (!teamCache) teamCache = await prisma.team.findMany({ select: { id: true, name: true } });
  const candidates = [fdoName, fdoShort].map(canonName);
  const match = teamCache.find((t) => {
    const tKey = canonName(t.name);
    return candidates.some((c) => c.includes(tKey) || tKey.includes(c));
  });
  if (match) return match;
  // Fallback: strip common suffixes and retry
  const stripped = canonName(fdoName.replace(/\b(fc|united|city|rovers|wanderers|athletic)\b/gi, '').trim());
  return teamCache.find((t) => {
    const tKey = canonName(t.name);
    return stripped.includes(tKey) || tKey.includes(stripped);
  }) ?? null;
}

type Result = 'win' | 'draw' | 'loss';

async function settleMatch(match: FdoMatch) {
  const homeScore = match.score.fullTime.home ?? 0;
  const awayScore = match.score.fullTime.away ?? 0;
  const homeTeam = await resolveTeam(match.homeTeam.name, match.homeTeam.shortName);
  const awayTeam = await resolveTeam(match.awayTeam.name, match.awayTeam.shortName);

  if (!homeTeam || !awayTeam) {
    console.warn(`  Skipping – unresolved teams: "${match.homeTeam.name}" vs "${match.awayTeam.name}"`);
    return false;
  }

  const homeResult: Result = homeScore > awayScore ? 'win' : homeScore < awayScore ? 'loss' : 'draw';
  const awayResult: Result = homeScore < awayScore ? 'win' : homeScore > awayScore ? 'loss' : 'draw';

  const dbMatch = await prisma.match.upsert({
    where: { externalId: String(match.id) },
    create: {
      externalId: String(match.id),
      homeTeamId: homeTeam.id,
      awayTeamId: awayTeam.id,
      kickoffAt: new Date(match.utcDate),
      status: 'finished',
      homeScore,
      awayScore,
    },
    update: { status: 'finished', homeScore, awayScore },
  });

  const squads: Array<{ teamId: number; result: Result }> = [
    { teamId: homeTeam.id, result: homeResult },
    { teamId: awayTeam.id, result: awayResult },
  ];

  for (const { teamId, result } of squads) {
    const players = await prisma.player.findMany({ where: { teamId } });
    const valuations: Array<{ playerId: number; price: number; basePrice: number; matchId: number }> = [];

    for (const player of players) {
      // Price moves on result only — goals/assists come from update-player-stats.ts via FBref
      const perf: MatchPerf = { goals: 0, assists: 0, minutes: 90, result };

      await prisma.playerMatchStat.upsert({
        where: { playerId_matchId: { playerId: player.id, matchId: dbMatch.id } },
        create: { playerId: player.id, matchId: dbMatch.id, goals: 0, assists: 0, minutes: 90, result },
        update: { result },
      });

      const latest = await prisma.valuation.findFirst({
        where: { playerId: player.id },
        orderBy: { computedAt: 'desc' },
      });
      if (!latest) continue;

      const newPrice = applyMatchToPrice(latest.price, perf);
      valuations.push({ playerId: player.id, price: newPrice, basePrice: newPrice, matchId: dbMatch.id });
    }

    await prisma.valuation.createMany({ data: valuations });

    // Recompute team price
    const updatedPlayers = await prisma.player.findMany({
      where: { teamId },
      include: { valuations: { orderBy: { computedAt: 'desc' }, take: 1 } },
    });
    const roster = updatedPlayers.map((p) => ({ price: p.valuations[0]?.price ?? 50, minutes: p.minutes }));
    await prisma.valuation.create({
      data: { teamId, price: teamPrice(roster, 0), basePrice: teamPrice(roster, 0), matchId: dbMatch.id },
    });
  }

  await prisma.match.update({
    where: { id: dbMatch.id },
    data: { status: 'settled', settledAt: new Date() },
  });

  return true;
}

async function main() {
  console.log('Fetching finished PL matches…');
  const data = (await fdoGet('/competitions/PL/matches?status=FINISHED')) as { matches: FdoMatch[] };

  const settled = await prisma.match.findMany({
    where: { externalId: { not: null }, status: 'settled' },
    select: { externalId: true },
  });
  const settledIds = new Set(settled.map((m) => m.externalId));
  const newMatches = data.matches.filter((m) => !settledIds.has(String(m.id)));

  console.log(`${newMatches.length} new match(es) to settle (${data.matches.length} total finished).`);

  let ok = 0, skipped = 0;
  for (const match of newMatches) {
    const settled = await settleMatch(match);
    settled ? ok++ : skipped++;
  }

  console.log(`Done. ${ok} settled, ${skipped} skipped.`);
  if (skipped > 0) console.log('Tip: run add-promoted-teams.ts for any unresolved clubs.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
