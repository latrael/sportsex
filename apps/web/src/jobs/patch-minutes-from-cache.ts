// patch-minutes-from-cache.ts — read patch_minutes_cache.json and update minutes in Postgres.
// Run from apps/web: npx tsx --env-file=.env src/jobs/patch-minutes-from-cache.ts [path/to/cache.json]
//
// Default cache path: ../../../../apps/jobs/patch_minutes_cache.json

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const prisma = new PrismaClient();

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .trim();
}

const NICKNAMES: Record<string, string[]> = {
  matty: ['matthew'], matt: ['matthew'],
  ollie: ['oliver'], olly: ['oliver'],
  eddie: ['edward'], eddi: ['edward'],
  ben: ['benjamin'],
  charlie: ['charles'],
  will: ['william'],
  jamie: ['james'],
  danny: ['daniel'], dan: ['daniel'],
  nicky: ['nicholas'], nick: ['nicholas'],
  tommy: ['thomas'], tom: ['thomas'],
  robbie: ['robert'], rob: ['robert'],
  jonny: ['jonathan'], jon: ['jonathan'],
  alex: ['alexander'],
  andy: ['andrew'],
  stevie: ['stephen', 'steven'], steve: ['stephen', 'steven'],
  mike: ['michael'],
  tony: ['anthony'],
  sam: ['samuel'],
  chris: ['christopher'],
};

interface ApiEntry {
  normFirst: string[];
  normLast: string[];
  mins: number;
  pid: number;
}

async function main() {
  const cachePath =
    process.argv[2] ??
    resolve(__dirname, '../../../../apps/jobs/patch_minutes_cache.json');

  console.log(`Reading cache from ${cachePath}…`);
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const entries: Array<{ player: { id: number; firstname: string; lastname: string }; statistics: Array<{ games?: { minutes?: number } }> }> = cache.players;

  // Aggregate minutes per API player id (handles mid-season transfers)
  const agg = new Map<number, { first: string; last: string; mins: number }>();
  for (const entry of entries) {
    const pid = entry.player?.id;
    if (!pid) continue;
    const mins = entry.statistics?.[0]?.games?.minutes ?? 0;
    const prev = agg.get(pid);
    if (prev) {
      prev.mins += mins;
    } else {
      agg.set(pid, {
        first: entry.player.firstname ?? '',
        last: entry.player.lastname ?? '',
        mins,
      });
    }
  }

  console.log(`${agg.size} unique API players in cache.`);

  // Build lookup structures
  const exactMap = new Map<string, { mins: number; pid: number }>();
  const apiEntries: ApiEntry[] = [];

  for (const [pid, data] of agg) {
    const key = norm(`${data.first} ${data.last}`);
    exactMap.set(key, { mins: data.mins, pid });
    apiEntries.push({
      normFirst: norm(data.first).split(/\s+/),
      normLast: norm(data.last).split(/\s+/),
      mins: data.mins,
      pid,
    });
  }

  // Load DB players
  const dbPlayers = await prisma.player.findMany({
    select: { id: true, fullName: true, minutes: true },
  });
  console.log(`${dbPlayers.length} players in DB.`);

  const consumedPids = new Set<number>();

  function fuzzyMatch(dbName: string): { mins: number; pid: number } | null {
    const words = norm(dbName).split(/\s+/);
    const dbFirst = words[0];
    const dbLast = words[words.length - 1];
    const single = words.length === 1;
    const firstCandidates = [dbFirst, ...(NICKNAMES[dbFirst] ?? [])];

    const candidates: Array<{ mins: number; pid: number }> = [];
    for (const e of apiEntries) {
      if (consumedPids.has(e.pid)) continue;
      const apiAll = [...e.normFirst, ...e.normLast];

      if (single) {
        if (apiAll.includes(dbFirst)) candidates.push({ mins: e.mins, pid: e.pid });
        continue;
      }

      if (!e.normLast.includes(dbLast)) continue;

      const matchedFirst = firstCandidates.some((fc) =>
        apiAll.some((aw) => aw.startsWith(fc))
      );
      if (matchedFirst) candidates.push({ mins: e.mins, pid: e.pid });
    }

    if (candidates.length === 1) return candidates[0];
    const nonzero = candidates.filter((c) => c.mins > 0);
    if (nonzero.length === 1) return nonzero[0];
    return null;
  }

  let patched = 0;
  let skipped = 0;
  const unmatched: string[] = [];

  for (const p of dbPlayers) {
    const key = norm(p.fullName);
    let hit = exactMap.get(key);
    let method = 'exact';

    if (hit && !consumedPids.has(hit.pid)) {
      consumedPids.add(hit.pid);
    } else {
      hit = fuzzyMatch(p.fullName) ?? undefined;
      method = 'fuzzy';
      if (hit) consumedPids.add(hit.pid);
    }

    if (!hit) {
      unmatched.push(p.fullName);
      continue;
    }

    if (hit.mins === p.minutes) {
      skipped++;
      continue;
    }

    await prisma.player.update({
      where: { id: p.id },
      data: { minutes: hit.mins },
    });
    patched++;
    console.log(`  [${method}] ${p.fullName}: ${p.minutes} → ${hit.mins} min`);
  }

  console.log(`\nPatched ${patched} player(s), ${skipped} already correct.`);
  if (unmatched.length > 0) {
    console.log(`No API match for ${unmatched.length} player(s):`);
    unmatched.slice(0, 20).forEach((n) => console.log(`  ${n}`));
    if (unmatched.length > 20) console.log(`  … and ${unmatched.length - 20} more`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
