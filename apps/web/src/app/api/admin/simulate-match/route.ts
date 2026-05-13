import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { applyMatchToPrice, teamPrice as computeTeamPrice } from '@/lib/pricing';

const schema = z.object({
  homeTeamId: z.number().int().positive(),
  awayTeamId: z.number().int().positive(),
  homeScore: z.number().int().min(0).max(20),
  awayScore: z.number().int().min(0).max(20),
});

function adminAuthorized(req: Request): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  return req.headers.get('x-admin-token') === token;
}

// Distribute goals + assists across roster proportional to minutes, with FWDs weighted more.
function distributeStats(
  roster: { id: number; posBucket: string | null; minutes: number }[],
  goals: number,
  assists: number,
): Map<number, { goals: number; assists: number }> {
  const out = new Map<number, { goals: number; assists: number }>();
  if (roster.length === 0) return out;

  const weights = roster.map((p) => {
    const posMult = p.posBucket === 'FWD' ? 4 : p.posBucket === 'MID' ? 2 : p.posBucket === 'DEF' ? 0.5 : 0.1;
    return Math.max(0.1, p.minutes * posMult);
  });
  const total = weights.reduce((s, w) => s + w, 0);

  function distribute(amount: number) {
    for (let i = 0; i < amount; i++) {
      const r = Math.random() * total;
      let acc = 0;
      for (let j = 0; j < roster.length; j++) {
        acc += weights[j];
        if (r <= acc) return roster[j].id;
      }
      return roster[roster.length - 1].id;
    }
  }
  for (let i = 0; i < goals; i++) {
    const id = distribute(1);
    if (id == null) continue;
    const cur = out.get(id) ?? { goals: 0, assists: 0 };
    cur.goals += 1;
    out.set(id, cur);
  }
  for (let i = 0; i < assists; i++) {
    const id = distribute(1);
    if (id == null) continue;
    const cur = out.get(id) ?? { goals: 0, assists: 0 };
    cur.assists += 1;
    out.set(id, cur);
  }
  return out;
}

export async function POST(req: Request) {
  if (!adminAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'bad_request', details: parsed.error.flatten() }, { status: 400 });
  const { homeTeamId, awayTeamId, homeScore, awayScore } = parsed.data;
  if (homeTeamId === awayTeamId) return NextResponse.json({ error: 'same_team' }, { status: 400 });

  const [home, away] = await Promise.all([
    prisma.team.findUnique({ where: { id: homeTeamId }, include: { players: true } }),
    prisma.team.findUnique({ where: { id: awayTeamId }, include: { players: true } }),
  ]);
  if (!home || !away) return NextResponse.json({ error: 'team_not_found' }, { status: 404 });

  const match = await prisma.match.create({
    data: {
      homeTeamId, awayTeamId,
      kickoffAt: new Date(),
      status: 'finished',
      homeScore, awayScore,
    },
  });

  // Pick rough lineups: top-15 by minutes for each team
  const homeRoster = [...home.players].sort((a, b) => b.minutes - a.minutes).slice(0, 15);
  const awayRoster = [...away.players].sort((a, b) => b.minutes - a.minutes).slice(0, 15);

  const homeContribs = distributeStats(homeRoster, homeScore, Math.floor(homeScore * 0.7));
  const awayContribs = distributeStats(awayRoster, awayScore, Math.floor(awayScore * 0.7));

  const homeResult: 'win' | 'draw' | 'loss' = homeScore > awayScore ? 'win' : homeScore === awayScore ? 'draw' : 'loss';
  const awayResult: 'win' | 'draw' | 'loss' = awayScore > homeScore ? 'win' : awayScore === homeScore ? 'draw' : 'loss';

  let priceChanges = 0;
  await prisma.$transaction(async (tx) => {
    async function processRoster(
      roster: typeof homeRoster,
      contribs: Map<number, { goals: number; assists: number }>,
      result: 'win' | 'draw' | 'loss',
    ) {
      for (const p of roster) {
        const c = contribs.get(p.id) ?? { goals: 0, assists: 0 };
        const minutes = 60 + Math.floor(Math.random() * 31); // 60-90
        await tx.playerMatchStat.create({
          data: {
            playerId: p.id,
            matchId: match.id,
            minutes,
            goals: c.goals,
            assists: c.assists,
            result,
          },
        });
        // bump season stats
        await tx.player.update({
          where: { id: p.id },
          data: {
            appearances: { increment: 1 },
            minutes: { increment: minutes },
            goals: { increment: c.goals },
            assists: { increment: c.assists },
          },
        });

        const last = await tx.valuation.findFirst({
          where: { playerId: p.id },
          orderBy: { computedAt: 'desc' },
        });
        const lastPrice = last?.price ?? 50;
        const newPrice = applyMatchToPrice(lastPrice, {
          goals: c.goals, assists: c.assists, minutes, result,
        });
        await tx.valuation.create({
          data: {
            playerId: p.id,
            price: newPrice,
            basePrice: newPrice,
            demandMult: last?.demandMult ?? 1,
            matchId: match.id,
          },
        });
        priceChanges++;
      }
    }

    await processRoster(homeRoster, homeContribs, homeResult);
    await processRoster(awayRoster, awayContribs, awayResult);

    await tx.match.update({ where: { id: match.id }, data: { settledAt: new Date(), status: 'settled' } });

    // Recompute team prices using updated roster prices
    for (const team of [home, away]) {
      const players = await tx.player.findMany({ where: { teamId: team.id } });
      // pull latest prices in a quick loop
      const prices: { price: number; minutes: number }[] = [];
      for (const p of players) {
        const v = await tx.valuation.findFirst({
          where: { playerId: p.id },
          orderBy: { computedAt: 'desc' },
        });
        if (v) prices.push({ price: v.price, minutes: p.minutes });
      }
      const tp = computeTeamPrice(prices, team.id === homeTeamId ? (homeResult === 'win' ? 3 : homeResult === 'draw' ? 1 : 0) : (awayResult === 'win' ? 3 : awayResult === 'draw' ? 1 : 0));
      await tx.valuation.create({
        data: { teamId: team.id, price: tp, basePrice: tp, demandMult: 1, matchId: match.id },
      });
    }
  }, { timeout: 60_000 });

  // Resolve any predictions on this match
  const preds = await prisma.prediction.findMany({ where: { matchId: match.id, resolved: false } });
  const winningPick = homeResult === 'win' ? 'H' : awayResult === 'win' ? 'A' : 'D';
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

  return NextResponse.json({ ok: true, matchId: match.id, priceChanges, resolvedPredictions: preds.length });
}
