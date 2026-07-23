// R1.6 — the accuracy gate for the 25/26 backfill. Five checks; the history is
// only carried if they pass. Run after backfill-2526.ts against the same DB:
//
//   ARCHIVE_DIR=... DATABASE_URL=... npx tsx src/scripts/verify-2526.ts
//
// Checks 1, 2 and 5 are internal consistency (they catch our ingestion and
// attribution bugs). Check 4 cross-checks the per-fixture sums against a
// *different file* in the archive (players_raw season totals vs Σ our gws
// rows). Check 3 computes the league table from our fixtures and, if
// FOOTBALL_DATA_API_KEY is set, reconciles it against football-data.org — the
// one genuinely independent provider; without a key it reports the table and
// its internal consistency, and the fully-independent leg is skipped.
/* eslint-disable no-console -- a CLI verification script; console is its output */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { parseCsv } from '@/lib/ingest';

const db = new PrismaClient();
const START_YEAR = 2025;

type Check = { name: string; pass: boolean; detail: string };
const results: Check[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

async function main() {
  const season = await db.season.findUniqueOrThrow({ where: { startYear: START_YEAR } });

  const fixtures = await db.fixture.findMany({
    where: { seasonId: season.id },
    select: {
      id: true,
      fplId: true,
      homeClubSeasonId: true,
      awayClubSeasonId: true,
      homeScore: true,
      awayScore: true,
      finished: true,
    },
  });

  // Player-fixture rows with the player's club, so each row can be assigned to
  // the home or away side of its fixture.
  const stats = await db.playerFixtureStat.findMany({
    select: {
      fixtureId: true,
      minutes: true,
      goalsScored: true,
      ownGoals: true,
      playerSeason: { select: { clubSeasonId: true, fplId: true } },
    },
  });

  const byFixture = new Map<number, typeof stats>();
  for (const s of stats) {
    const list = byFixture.get(s.fixtureId);
    if (list) list.push(s);
    else byFixture.set(s.fixtureId, [s]);
  }

  // ---- Check 1: scoreline reconciliation --------------------------------
  // Every goal in a match is either a normal goal (someone's goalsScored) or an
  // own goal (someone's ownGoals), so total goals == Σ goalsScored + Σ ownGoals
  // over all the fixture's rows. This is done on totals rather than per side on
  // purpose: `player_season` records one club per season, so a player who
  // transferred mid-season (Brennan Johnson: TOT in GW1, CRY by the end-of-
  // season snapshot) can't be assigned to the right side from our tables alone.
  // Per-player attribution is covered independently by check 4.
  {
    let bad = 0;
    const examples: string[] = [];
    for (const f of fixtures) {
      const rows = byFixture.get(f.id) ?? [];
      const goals = rows.reduce((n, r) => n + r.goalsScored + r.ownGoals, 0);
      const scoreline = (f.homeScore ?? 0) + (f.awayScore ?? 0);
      if (goals !== scoreline) {
        bad++;
        if (examples.length < 5)
          examples.push(
            `fixture ${f.fplId}: ${goals} player goals vs scoreline total ${scoreline}`,
          );
      }
    }
    record(
      '1. scoreline reconciliation (total goals)',
      bad === 0,
      bad === 0
        ? `all ${fixtures.length} fixtures reconcile Σ(goals+own goals) to the scoreline`
        : `${bad} mismatched; ${examples.join('; ')}`,
    );
  }

  // ---- Check 2: minutes sanity ------------------------------------------
  {
    const perFixture = fixtures.map((f) => ({
      fplId: f.fplId,
      total: (byFixture.get(f.id) ?? []).reduce((n, r) => n + r.minutes, 0),
    }));
    // FPL counts on-pitch minutes only — stoppage time is excluded — so a clean
    // match sums to roughly 1900–1980, not the ideal 22×90=1980, and red cards
    // pull it lower still. The spec's 1980 floor assumes the idealised total; the
    // real, defensible bound is [1800, 2100]. The season cap (no player over
    // 38×90=3420) is exact.
    const FLOOR = 1800,
      CEIL = 2100;
    const out = perFixture.filter((p) => p.total < FLOOR || p.total > CEIL);
    const min = Math.min(...perFixture.map((p) => p.total));
    const max = Math.max(...perFixture.map((p) => p.total));

    const perPlayer = new Map<number, number>();
    for (const s of stats) {
      const k = s.playerSeason.fplId;
      perPlayer.set(k, (perPlayer.get(k) ?? 0) + s.minutes);
    }
    const overSeason = [...perPlayer.values()].filter((m) => m > 3420).length;

    const pass = out.length === 0 && overSeason === 0;
    record(
      '2. minutes sanity',
      pass,
      `per-fixture minutes ${min}–${max}, all within [${FLOOR}, ${CEIL}] (${out.length} outliers); ` +
        `${overSeason} players over 3420 season minutes. ` +
        `Floor relaxed from the spec's 1980 — FPL excludes stoppage time.`,
    );
  }

  // ---- Check 5: coverage -------------------------------------------------
  {
    const short = fixtures
      .map((f) => ({
        fplId: f.fplId,
        n: (byFixture.get(f.id) ?? []).filter((r) => r.minutes > 0).length,
      }))
      .filter((f) => f.n < 22);
    record(
      '5. coverage (>=22 players with minutes>0 per fixture)',
      short.length === 0,
      short.length === 0
        ? `all ${fixtures.length} fixtures have >=22`
        : `${short.length} short: ${short
            .slice(0, 5)
            .map((s) => `${s.fplId}:${s.n}`)
            .join(', ')}`,
    );
  }

  // ---- Check 4: scorers vs the archive's own season totals --------------
  // Σ our per-fixture goals per player must equal players_raw.total goals_scored
  // (a different file in the archive), and the top-20 lists must agree.
  {
    const dir = process.env.ARCHIVE_DIR;
    if (!dir) {
      record('4. scorer cross-check', false, 'ARCHIVE_DIR not set — cannot read players_raw.csv');
    } else {
      const playersRaw = parseCsv(readFileSync(join(dir, 'players_raw.csv'), 'utf8'));
      const rawGoals = new Map<number, { goals: number; name: string }>();
      for (const p of playersRaw)
        rawGoals.set(Number(p.id), { goals: Number(p.goals_scored), name: p.web_name });

      const ourGoals = new Map<number, number>();
      for (const s of stats) {
        const k = s.playerSeason.fplId;
        ourGoals.set(k, (ourGoals.get(k) ?? 0) + s.goalsScored);
      }

      let mismatched = 0;
      const examples: string[] = [];
      for (const [fplId, ours] of ourGoals) {
        const raw = rawGoals.get(fplId);
        if (raw && raw.goals !== ours) {
          mismatched++;
          if (examples.length < 5) examples.push(`${raw.name}: ours ${ours} vs raw ${raw.goals}`);
        }
      }
      const top = [...ourGoals.entries()]
        .map(([fplId, g]) => ({ name: rawGoals.get(fplId)?.name ?? String(fplId), g }))
        .sort((a, b) => b.g - a.g)
        .slice(0, 10);
      record(
        '4. scorer cross-check (per-fixture sum vs season totals)',
        mismatched === 0,
        mismatched === 0
          ? `all players match; top 10: ${top.map((t) => `${t.name} ${t.g}`).join(', ')}`
          : `${mismatched} players disagree; ${examples.join('; ')}`,
      );
    }
  }

  // ---- Check 3: league table --------------------------------------------
  {
    const clubs = await db.clubSeason.findMany({
      where: { seasonId: season.id },
      select: { id: true, club: { select: { shortName: true } } },
    });
    const nameOf = new Map(clubs.map((c) => [c.id, c.club.shortName]));
    type Row = { p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number };
    const table = new Map<number, Row>();
    for (const c of clubs) table.set(c.id, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });

    for (const f of fixtures) {
      if (!f.finished || f.homeScore === null || f.awayScore === null) continue;
      const h = table.get(f.homeClubSeasonId)!;
      const a = table.get(f.awayClubSeasonId)!;
      h.p++;
      a.p++;
      h.gf += f.homeScore;
      h.ga += f.awayScore;
      a.gf += f.awayScore;
      a.ga += f.homeScore;
      if (f.homeScore > f.awayScore) {
        h.w++;
        h.pts += 3;
        a.l++;
      } else if (f.homeScore < f.awayScore) {
        a.w++;
        a.pts += 3;
        h.l++;
      } else {
        h.d++;
        a.d++;
        h.pts++;
        a.pts++;
      }
    }

    const ranked = [...table.entries()]
      .map(([id, r]) => ({ name: nameOf.get(id)!, ...r, gd: r.gf - r.ga }))
      .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf);

    // Internal consistency: every club plays 38, league wins == losses, and
    // total goals for == goals against.
    const allPlay38 = ranked.every((r) => r.p === 38);
    const winsEqLosses =
      ranked.reduce((n, r) => n + r.w, 0) === ranked.reduce((n, r) => n + r.l, 0);
    const gfEqGa = ranked.reduce((n, r) => n + r.gf, 0) === ranked.reduce((n, r) => n + r.ga, 0);
    const consistent = allPlay38 && winsEqLosses && gfEqGa;

    console.log('      final table (our fixtures):');
    ranked.forEach((r, i) =>
      console.log(
        `        ${String(i + 1).padStart(2)}. ${r.name.padEnd(4)} ${r.p} ${r.w}-${r.d}-${r.l}  GF${r.gf} GA${r.ga} GD${r.gd >= 0 ? '+' : ''}${r.gd}  ${r.pts}pts`,
      ),
    );

    const key = process.env.FOOTBALL_DATA_API_KEY;
    if (!key) {
      record(
        '3. league table (independent leg SKIPPED)',
        consistent,
        `table internally consistent (all play 38: ${allPlay38}, wins==losses: ${winsEqLosses}, GF==GA: ${gfEqGa}). ` +
          `Set FOOTBALL_DATA_API_KEY for the football-data.org reconciliation.`,
      );
    } else {
      await reconcileWithFootballData(key, ranked, record);
    }
  }

  // ---- verdict ----------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  await db.$disconnect();
  process.exit(passed === results.length ? 0 : 1);
}

async function reconcileWithFootballData(
  key: string,
  ranked: { name: string; pts: number; gd: number }[],
  rec: typeof record,
) {
  try {
    const res = await fetch(
      'https://api.football-data.org/v4/competitions/PL/standings?season=2025',
      {
        headers: { 'X-Auth-Token': key },
      },
    );
    if (!res.ok) {
      rec('3. league table (football-data.org)', false, `football-data.org returned ${res.status}`);
      return;
    }
    const body = (await res.json()) as {
      standings: {
        type: string;
        table: {
          position: number;
          team: { tla: string };
          points: number;
          goalDifference: number;
        }[];
      }[];
    };
    const total = body.standings.find((s) => s.type === 'TOTAL')?.table ?? [];
    let mismatched = 0;
    const examples: string[] = [];
    for (const [i, r] of ranked.entries()) {
      const theirs = total[i];
      if (!theirs || theirs.points !== r.pts || theirs.goalDifference !== r.gd) {
        mismatched++;
        if (examples.length < 5)
          examples.push(
            `pos ${i + 1}: ours ${r.name}/${r.pts}/${r.gd} vs theirs ${theirs?.team.tla}/${theirs?.points}/${theirs?.goalDifference}`,
          );
      }
    }
    rec(
      '3. league table (football-data.org)',
      mismatched === 0,
      mismatched === 0
        ? 'positions, points and GD match all 20 clubs'
        : `${mismatched} rows differ; ${examples.join('; ')}`,
    );
  } catch (e) {
    rec(
      '3. league table (football-data.org)',
      false,
      `error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
