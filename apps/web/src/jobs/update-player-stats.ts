// update-player-stats.ts — import season stats from a CSV into the DB.
// Run from apps/web: npx tsx --env-file=.env src/jobs/update-player-stats.ts [path/to/csv]
//
// Default CSV path: ../../../../epl_player_stats_25_26.csv (repo root)
// Generate it first: python3 apps/jobs/epl_2526_fbref_scrape.py
//
// Players found in the CSV but missing from the DB are created automatically
// so newly transferred players get added without a full reseed.

import { PrismaClient } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { canonName } from '../lib/canon';
import { seedPrice } from '../lib/pricing';

const prisma = new PrismaClient();

function readCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
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
  if (p.startsWith('M') || p === 'MIDFIELDER') return 'MID';
  if (p.startsWith('F') || p === 'ATT' || p === 'OFFENCE' || p === 'CENTRE-FORWARD') return 'FWD';
  return 'OTHER';
}

async function main() {
  const csvPath = process.argv[2]
    ?? resolve(__dirname, '../../../../epl_player_stats_25_26.csv');

  console.log(`Reading ${csvPath}…`);
  const rows = readCsv(csvPath);
  console.log(`${rows.length} rows in CSV.`);

  const allPlayers = await prisma.player.findMany({ select: { id: true, playerKey: true } });
  const playerByKey = new Map(allPlayers.map((p) => [p.playerKey, p.id]));

  const allTeams = await prisma.team.findMany({ select: { id: true, name: true, shortName: true } });

  const ALIASES: Record<string, string> = {
    'man united': 'manchester united',
    'man city': 'manchester city',
    'spurs': 'tottenham hotspur',
    'wolves': 'wolverhampton wanderers',
    'nottingham': 'nottingham forest',
  };

  function resolveTeam(clubRaw: string): number | null {
    const raw = canonName(clubRaw);
    const candidate = ALIASES[raw] ?? raw;
    // Exact match first
    for (const t of allTeams) {
      if (canonName(t.name) === candidate || canonName(t.shortName ?? '') === candidate) return t.id;
    }
    // Substring match — handles "Man City" ↔ "Manchester City", "Tottenham" ↔ "Tottenham Hotspur", etc.
    for (const t of allTeams) {
      const tKey = canonName(t.name);
      if (candidate.includes(tKey) || tKey.includes(candidate)) return t.id;
    }
    return null;
  }

  let updated = 0, created = 0, unmatched = 0;
  const unmatchedNames: string[] = [];

  for (const row of rows) {
    const name = row['Player Name'] ?? '';
    if (!name) continue;

    const goals       = toInt(row['Goals']);
    const assists     = toInt(row['Assists']);
    const minutes     = toInt(row['Minutes']);
    const appearances = toInt(row['Appearances']);

    const key = canonName(name);
    let playerId = playerByKey.get(key);

    if (!playerId) {
      const clubKey = `${key} ${canonName(row['Club'] ?? '')}`.trim();
      playerId = playerByKey.get(clubKey);
    }

    if (playerId) {
      await prisma.player.update({
        where: { id: playerId },
        data: { goals, assists, minutes, appearances },
      });
      updated++;
      continue;
    }

    // Player not in DB — resolve their team and create them
    const clubRaw = row['Club'] ?? '';
    const teamId = resolveTeam(clubRaw);

    if (!teamId) {
      unmatched++;
      unmatchedNames.push(`${name} (${clubRaw})`);
      continue;
    }

    const price = seedPrice({ goals, assists, minutes });
    const newPlayer = await prisma.player.create({
      data: {
        playerKey:   key,
        fullName:    name,
        teamId,
        position:    row['Position'] ?? null,
        posBucket:   posBucket(row['Position'] ?? ''),
        nationality: row['Nationality'] ?? null,
        goals,
        assists,
        minutes,
        appearances,
        totalShares: 10000,
        sharesHeld:  0,
      },
    });

    await prisma.valuation.create({
      data: { playerId: newPlayer.id, price, basePrice: price, demandMult: 1.0 },
    });

    playerByKey.set(key, newPlayer.id);
    created++;
    console.log(`  Created: ${name} (${clubRaw})`);
  }

  console.log(`Updated ${updated} player(s), created ${created} new player(s).`);
  if (unmatched > 0) {
    console.log(`No DB match for ${unmatched} row(s) — team not found in DB:`);
    unmatchedNames.forEach((n) => console.log(`  ${n}`));
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
