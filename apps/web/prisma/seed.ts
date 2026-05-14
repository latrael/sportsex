import { PrismaClient } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { canonName } from '../src/lib/canon';
import { seedPrice, teamPrice } from '../src/lib/pricing';

const prisma = new PrismaClient();
const repoRoot = resolve(__dirname, '..', '..', '..');

function readCsv(path: string): Record<string, string>[] {
  const buf = readFileSync(path);
  // Strip BOM if present
  const text = buf.toString('utf8').replace(/^﻿/, '');
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}

function toInt(v: unknown, d = 0): number {
  if (v === undefined || v === null || v === '') return d;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : d;
}

function posBucket(position: string): string {
  const p = (position || '').toUpperCase();
  if (p.startsWith('G')) return 'GK';
  if (p.startsWith('D')) return 'DEF';
  if (p.startsWith('M')) return 'MID';
  if (p.startsWith('F') || p === 'ATT') return 'FWD';
  return 'OTHER';
}

async function main() {
  console.log('Reading CSVs…');
  const statsPath = join(repoRoot, 'epl_player_stats_24_25.csv');
  const stats = readCsv(statsPath);

  console.log(`Seeding ${stats.length} players.`);

  // Distinct clubs → teams
  const clubs = Array.from(new Set(stats.map((r) => r['Club']).filter(Boolean)));
  console.log(`Found ${clubs.length} clubs.`);

  await prisma.$transaction(async (tx) => {
    // Wipe in dependency order
    await tx.userQuest.deleteMany();
    await tx.quest.deleteMany();
    await tx.prediction.deleteMany();
    await tx.comment.deleteMany();
    await tx.transaction.deleteMany();
    await tx.holding.deleteMany();
    await tx.order.deleteMany();
    await tx.valuation.deleteMany();
    await tx.playerMatchStat.deleteMany();
    await tx.match.deleteMany();
    await tx.player.deleteMany();
    await tx.team.deleteMany();

    const teamIdByName = new Map<string, number>();
    for (const name of clubs) {
      const t = await tx.team.create({
        data: { name, shortName: name.length > 12 ? name.slice(0, 12) : name },
      });
      teamIdByName.set(name, t.id);
    }

    const playersToCreate: {
      playerKey: string;
      fullName: string;
      teamId: number | null;
      position: string;
      posBucket: string;
      nationality: string;
      appearances: number;
      minutes: number;
      goals: number;
      assists: number;
    }[] = [];
    const seenKeys = new Set<string>();

    for (const r of stats) {
      const fullName = r['Player Name'];
      if (!fullName) continue;
      let key = canonName(fullName);
      // Disambiguate exact-name collisions by appending club
      if (seenKeys.has(key)) {
        key = `${key} ${canonName(r['Club'] || '')}`.trim();
        if (seenKeys.has(key)) continue;
      }
      seenKeys.add(key);
      const teamId = teamIdByName.get(r['Club']) ?? null;
      playersToCreate.push({
        playerKey: key,
        fullName,
        teamId,
        position: r['Position'] || 'OTHER',
        posBucket: posBucket(r['Position'] || ''),
        nationality: r['Nationality'] || '',
        appearances: toInt(r['Appearances']),
        minutes: toInt(r['Minutes']),
        goals: toInt(r['Goals']),
        assists: toInt(r['Assists']),
      });
    }

    // createMany for speed
    await tx.player.createMany({ data: playersToCreate });
    console.log(`Created ${playersToCreate.length} players.`);

    const allPlayers = await tx.player.findMany();

    // Initial valuations
    const valuationData = allPlayers.map((p) => {
      const price = seedPrice({ goals: p.goals, assists: p.assists, minutes: p.minutes });
      return { playerId: p.id, price, basePrice: price, demandMult: 1.0 };
    });
    await tx.valuation.createMany({ data: valuationData });

    // Team valuations
    const teams = await tx.team.findMany({ include: { players: true } });
    const playerPriceById = new Map(allPlayers.map((p, i) => [p.id, valuationData[i].price]));
    for (const t of teams) {
      const roster = t.players.map((p) => ({
        price: playerPriceById.get(p.id) ?? 50,
        minutes: p.minutes,
      }));
      const price = teamPrice(roster, 0);
      await tx.valuation.create({
        data: { teamId: t.id, price, basePrice: price, demandMult: 1.0 },
      });
    }

    // Seed a handful of upcoming scheduled matches for predictions
    const allTeams = await tx.team.findMany({ select: { id: true, name: true } });
    if (allTeams.length >= 2) {
      const shuffled = [...allTeams].sort(() => Math.random() - 0.5);
      const fixtures = [
        [shuffled[0], shuffled[1]],
        [shuffled[2], shuffled[3]],
        [shuffled[4], shuffled[5]],
        [shuffled[6], shuffled[7]],
        [shuffled[8], shuffled[9]],
        [shuffled[10], shuffled[11]],
      ].filter((pair) => pair[0] && pair[1]);
      for (let i = 0; i < fixtures.length; i++) {
        const [home, away] = fixtures[i];
        const kickoffAt = new Date();
        kickoffAt.setDate(kickoffAt.getDate() + i + 1); // 1..6 days out
        kickoffAt.setHours(15, 0, 0, 0);
        await tx.match.create({
          data: {
            homeTeamId: home.id,
            awayTeamId: away.id,
            kickoffAt,
            status: 'scheduled',
          },
        });
      }
    }

    // Seed quests
    await tx.quest.createMany({
      data: [
        { code: 'login_today', title: 'Daily Login', body: 'Sign in today.', rewardCoins: 100, repeatKind: 'daily' },
        { code: 'place_one_trade', title: 'Make a Move', body: 'Place one buy or sell order today.', rewardCoins: 200, repeatKind: 'daily' },
        { code: 'comment_on_player', title: 'Hot Take', body: 'Post a comment on any player.', rewardCoins: 150, repeatKind: 'daily' },
        { code: 'onboarding_picks', title: 'First Picks', body: 'Buy shares in 3 different players.', rewardCoins: 500, repeatKind: 'one_shot' },
      ],
    });
  }, { timeout: 60_000 });

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
