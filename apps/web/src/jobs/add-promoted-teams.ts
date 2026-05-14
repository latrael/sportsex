// add-promoted-teams.ts — adds newly promoted clubs and their squads to the DB.
// Run from apps/web: npx tsx --env-file=.env src/jobs/add-promoted-teams.ts
//
// After this runs, re-run sync-matches.ts to settle the fixtures that were skipped.

import { PrismaClient } from '@prisma/client';
import { canonName } from '../lib/canon';
import { seedPrice } from '../lib/pricing';

const prisma = new PrismaClient();
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BASE = 'https://api.football-data.org/v4';

if (!API_KEY) {
  console.error('FOOTBALL_DATA_API_KEY is not set.');
  process.exit(1);
}

const PROMOTED_TEAMS = ['Leeds United', 'Burnley', 'Sunderland'];

async function fdoGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Auth-Token': API_KEY! },
  });
  if (!res.ok) throw new Error(`FDO ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

function posBucket(fdoPosition: string): string {
  const p = (fdoPosition || '').toLowerCase();
  if (p === 'goalkeeper') return 'GK';
  if (p === 'defence') return 'DEF';
  if (p === 'midfield') return 'MID';
  if (p === 'offence') return 'FWD';
  return 'OTHER';
}

function toPosition(fdoPosition: string): string {
  const p = (fdoPosition || '').toLowerCase();
  if (p === 'goalkeeper') return 'GK';
  if (p === 'defence') return 'DEF';
  if (p === 'midfield') return 'MID';
  if (p === 'offence') return 'FW';
  return 'OTHER';
}

async function main() {
  // Fetch all PL teams for this season
  const data = (await fdoGet('/competitions/PL/teams')) as {
    teams: Array<{ id: number; name: string; shortName: string; tla: string }>;
  };

  const promotedFdo = data.teams.filter((t) =>
    PROMOTED_TEAMS.some((name) => canonName(t.name).includes(canonName(name)) || canonName(name).includes(canonName(t.name)))
  );

  if (promotedFdo.length === 0) {
    console.error('Could not find any promoted teams in PL team list. Check team names.');
    console.log('Available teams:', data.teams.map((t) => t.name).join(', '));
    process.exit(1);
  }

  console.log(`Found ${promotedFdo.length} promoted team(s): ${promotedFdo.map((t) => t.name).join(', ')}`);

  // Check which are already in the DB
  const existingTeams = await prisma.team.findMany({ select: { name: true } });
  const existingKeys = new Set(existingTeams.map((t) => canonName(t.name)));

  for (const fdoTeam of promotedFdo) {
    const teamKey = canonName(fdoTeam.name);
    if (existingKeys.has(teamKey)) {
      console.log(`  ${fdoTeam.name} already in DB — skipping.`);
      continue;
    }

    console.log(`\nAdding ${fdoTeam.name}…`);

    // Create team
    const team = await prisma.team.create({
      data: {
        name: fdoTeam.shortName || fdoTeam.name,
        shortName: fdoTeam.tla || fdoTeam.shortName?.slice(0, 12) || fdoTeam.name.slice(0, 12),
        league: 'EPL',
      },
    });
    console.log(`  Created team: ${team.name} (id=${team.id})`);

    // Fetch squad
    await new Promise((r) => setTimeout(r, 6500)); // rate limit
    const squadData = (await fdoGet(`/teams/${fdoTeam.id}`)) as {
      squad: Array<{ name: string; position: string; nationality: string }>;
    };

    const squad = squadData.squad ?? [];
    if (squad.length === 0) {
      console.warn(`  No squad data returned for ${fdoTeam.name}`);
      continue;
    }

    // Get existing player keys to avoid collisions
    const allPlayerKeys = await prisma.player.findMany({ select: { playerKey: true } });
    const usedKeys = new Set(allPlayerKeys.map((p) => p.playerKey));

    const playersToCreate: Array<{
      playerKey: string;
      fullName: string;
      teamId: number;
      position: string;
      posBucket: string;
      nationality: string;
    }> = [];

    for (const p of squad) {
      if (!p.name) continue;
      let key = canonName(p.name);
      if (usedKeys.has(key)) {
        key = `${key} ${canonName(fdoTeam.shortName || fdoTeam.name)}`.trim();
        if (usedKeys.has(key)) continue;
      }
      usedKeys.add(key);
      playersToCreate.push({
        playerKey: key,
        fullName: p.name,
        teamId: team.id,
        position: toPosition(p.position),
        posBucket: posBucket(p.position),
        nationality: p.nationality || '',
      });
    }

    await prisma.player.createMany({ data: playersToCreate });
    console.log(`  Created ${playersToCreate.length} players.`);

    // Seed initial valuations at floor price (no stats yet — sync will build them up)
    const newPlayers = await prisma.player.findMany({ where: { teamId: team.id } });
    const basePrice = seedPrice({ goals: 0, assists: 0, minutes: 0 }); // = 50
    await prisma.valuation.createMany({
      data: newPlayers.map((p) => ({
        playerId: p.id,
        price: basePrice,
        basePrice,
        demandMult: 1.0,
      })),
    });

    // Seed team valuation
    await prisma.valuation.create({
      data: { teamId: team.id, price: basePrice, basePrice, demandMult: 1.0 },
    });

    console.log(`  Seeded valuations at ${basePrice} per player.`);
  }

  console.log('\nDone. Now re-run sync-matches.ts to settle skipped fixtures.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
