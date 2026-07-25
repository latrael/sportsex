// The database half of R2.3: the recompute lands one row per player, a second
// run writes nothing (invariant 4), an edited event row moves the aggregate,
// and `--check` reports drift without writing.
//
// The season here is the sample fixture family (20 players, GW1 + GW33 with its
// double). The same thing at full scale — 841 players, 29,747 fixture rows —
// runs in scripts/recompute-season-stats.ts; the accept is recorded in
// TODO_2627.md R2.3.

import { describe, it, expect, beforeEach } from 'vitest';
import { db, cleanDb } from '../helpers';
import { parseBootstrapStatic, parseEventLive, parseFixtures } from '@/lib/fpl';
import {
  planBootstrap,
  planEventLive,
  planFixtures,
  syncBootstrap,
  syncEventLive,
  syncFixtures,
} from '@/lib/ingest';
import { recomputeSeasonStats, SeasonStatsSyncError } from '@/lib/derive';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';
import gw1Sample from '../fixtures/fpl/event-1-live.sample.json';
import gw33Sample from '../fixtures/fpl/event-33-live.sample.json';

const bootstrap = parseBootstrapStatic(bootstrapSample);
const fixtures = parseFixtures(fixturesSample);
const gw1 = parseEventLive(gw1Sample);
const gw33 = parseEventLive(gw33Sample);

async function ingestSeason() {
  await syncBootstrap(db, planBootstrap(bootstrap));
  await syncFixtures(db, planFixtures(fixtures), { startYear: 2025 });
  await syncEventLive(db, planEventLive(gw1), { startYear: 2025, gameweekNumber: 1 });
  await syncEventLive(db, planEventLive(gw33), { startYear: 2025, gameweekNumber: 33 });
}

const recompute = (opts: { check?: boolean } = {}) =>
  recomputeSeasonStats(db, { startYear: 2025, ...opts });

beforeEach(async () => {
  await cleanDb();
});

describe('recomputeSeasonStats — ordering', () => {
  it('refuses to run for a season that is not in the database', async () => {
    await expect(recompute()).rejects.toThrow(SeasonStatsSyncError);
  });
});

describe('recomputeSeasonStats', () => {
  beforeEach(async () => {
    await ingestSeason();
  });

  it('writes one aggregate per player in the season', async () => {
    const result = await recompute();

    const players = await db.playerSeason.count();
    expect(result.seasonStats).toEqual({ created: players, updated: 0, unchanged: 0 });
    // Real live payloads: `explain` omits the conditionally-scoring stats, which
    // is expected and silent. Nothing here should warn.
    expect(result.warnings).toEqual([]);
    expect(await db.playerSeasonStat.count()).toBe(players);
  });

  it('keeps the defensive stats explain drops, at the gameweek total', async () => {
    await recompute();

    // The failure this guards: summing `explain` would report a keeper with no
    // saves and a defender with no goals conceded, because neither scored points.
    const perGameweek = await db.playerGameweekStat.aggregate({
      _sum: { saves: true, goalsConceded: true, cleanSheets: true, defensiveContribution: true },
    });
    const perFixture = await db.playerFixtureStat.aggregate({
      _sum: { saves: true, goalsConceded: true, cleanSheets: true, defensiveContribution: true },
    });
    const stored = await db.playerSeasonStat.aggregate({
      _sum: { saves: true, goalsConceded: true, cleanSheets: true, defensiveContribution: true },
    });

    expect(stored._sum).toEqual(perGameweek._sum);
    // And the per-fixture grain really is short, so this is not a tautology.
    expect(perFixture._sum.goalsConceded!).toBeLessThan(perGameweek._sum.goalsConceded!);
    expect(perFixture._sum.defensiveContribution!).toBeLessThan(
      perGameweek._sum.defensiveContribution!,
    );
  });

  it('reproduces the stored aggregates exactly on a re-run (invariant 4)', async () => {
    await recompute();
    const before = await db.playerSeasonStat.findMany({ orderBy: { id: 'asc' } });

    const second = await recompute();
    expect(second.seasonStats.created).toBe(0);
    expect(second.seasonStats.updated).toBe(0);
    expect(second.seasonStats.unchanged).toBe(before.length);

    // Byte-identical, computedAt included: an unchanged aggregate is not rewritten.
    expect(await db.playerSeasonStat.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('sums a double gameweek to two appearances and one set of model inputs', async () => {
    await recompute();

    // Element 67 plays both GW33 fixtures (see ingest-live.test.ts).
    const ps = await db.playerSeason.findFirstOrThrow({ where: { fplId: 67 } });
    const gw33Id = (await db.gameweek.findFirstOrThrow({ where: { number: 33 } })).id;
    const doubleRows = await db.playerFixtureStat.findMany({
      where: { playerSeasonId: ps.id, gameweekId: gw33Id },
    });
    const doubleGw = await db.playerGameweekStat.findFirstOrThrow({
      where: { playerSeasonId: ps.id, gameweekId: gw33Id },
    });
    const allFixtureRows = await db.playerFixtureStat.findMany({
      where: { playerSeasonId: ps.id },
    });
    const allGwRows = await db.playerGameweekStat.findMany({ where: { playerSeasonId: ps.id } });
    const stat = await db.playerSeasonStat.findUniqueOrThrow({
      where: { playerSeasonId: ps.id },
    });

    // Two fixtures, one gameweek row: appearances counts the fixtures, the
    // summed stats come from the single gameweek line that already covers both.
    expect(doubleRows).toHaveLength(2);
    expect(doubleRows.reduce((n, r) => n + r.minutes, 0)).toBe(doubleGw.minutes);

    expect(stat.appearances).toBe(allFixtureRows.filter((r) => r.minutes > 0).length);
    expect(stat.minutes).toBe(allGwRows.reduce((n, r) => n + r.minutes, 0));
    expect(stat.totalPoints).toBe(allGwRows.reduce((n, r) => n + r.totalPoints, 0));
    expect(stat.expectedGoalsConceded.toString()).toBe(
      allGwRows
        .reduce((acc, r) => acc.plus(r.expectedGoalsConceded), doubleGw.expectedGoalsConceded.mul(0))
        .toString(),
    );
  });

  it('agrees with a straight SQL rollup of the event rows', async () => {
    await recompute();

    const [rollup] = await db.$queryRaw<{ minutes: bigint; goals: bigint; points: bigint }[]>`
      SELECT SUM(minutes)::bigint AS minutes,
             SUM("goalsScored")::bigint AS goals,
             SUM("totalPoints")::bigint AS points
      FROM player_gameweek_stat`;
    const stored = await db.playerSeasonStat.aggregate({
      _sum: { minutes: true, goalsScored: true, totalPoints: true },
    });

    expect(BigInt(stored._sum.minutes ?? 0)).toBe(rollup.minutes);
    expect(BigInt(stored._sum.goalsScored ?? 0)).toBe(rollup.goals);
    expect(BigInt(stored._sum.totalPoints ?? 0)).toBe(rollup.points);
  });

  it('moves the aggregate when an event row is corrected, and only that row', async () => {
    await recompute();
    const ps = await db.playerSeason.findFirstOrThrow({ where: { fplId: 67 } });
    const before = await db.playerSeasonStat.findUniqueOrThrow({
      where: { playerSeasonId: ps.id },
    });

    // A late bonus-point correction, exactly what R6.4's re-settle produces.
    const row = await db.playerGameweekStat.findFirstOrThrow({
      where: { playerSeasonId: ps.id },
    });
    await db.playerGameweekStat.update({
      where: { id: row.id },
      data: { bonus: row.bonus + 3, totalPoints: row.totalPoints + 3 },
    });

    const result = await recompute();
    expect(result.seasonStats.updated).toBe(1);
    expect(result.seasonStats.created).toBe(0);

    const after = await db.playerSeasonStat.findUniqueOrThrow({
      where: { playerSeasonId: ps.id },
    });
    expect(after.bonus).toBe(before.bonus + 3);
    expect(after.totalPoints).toBe(before.totalPoints + 3);
    expect(after.computedAt.getTime()).toBeGreaterThanOrEqual(before.computedAt.getTime());
    // The stat is recomputed from scratch, so a stale row can only be corrected,
    // never compounded: running again does not add the +3 a second time.
    const third = await recompute();
    expect(third.seasonStats.updated).toBe(0);
  });

  it('moves appearances when the per-fixture grain changes', async () => {
    await recompute();
    const ps = await db.playerSeason.findFirstOrThrow({ where: { fplId: 67 } });
    const before = await db.playerSeasonStat.findUniqueOrThrow({
      where: { playerSeasonId: ps.id },
    });
    // GW1 plus both halves of the GW33 double.
    expect(before.appearances).toBe(3);

    // A postponed half of a double, withdrawn from the gameweek.
    const row = await db.playerFixtureStat.findFirstOrThrow({ where: { playerSeasonId: ps.id } });
    await db.playerFixtureStat.delete({ where: { id: row.id } });

    const result = await recompute();
    expect(result.seasonStats.updated).toBe(1);
    const after = await db.playerSeasonStat.findUniqueOrThrow({
      where: { playerSeasonId: ps.id },
    });
    expect(after.appearances).toBe(2);
    // Minutes are gameweek-grain, so they don't move — and the mismatch is now
    // real, so the cross-grain check says so.
    expect(after.minutes).toBe(before.minutes);
    expect(result.warnings.some((w) => w.includes(`playerSeasonId ${ps.id}: minutes`))).toBe(true);
  });

  it('check mode reports drift without writing', async () => {
    await recompute();
    const ps = await db.playerSeason.findFirstOrThrow({ where: { fplId: 67 } });
    const stored = await db.playerSeasonStat.findUniqueOrThrow({
      where: { playerSeasonId: ps.id },
    });

    // Corrupt the aggregate the way an `increment:` path eventually would.
    await db.playerSeasonStat.update({
      where: { id: stored.id },
      data: { minutes: stored.minutes + 90 },
    });

    const check = await recompute({ check: true });
    expect(check.drifted).toEqual([ps.id]);
    expect(check.seasonStats.updated).toBe(1);
    // Nothing was written: the corruption is still there for a real run to fix.
    const stillWrong = await db.playerSeasonStat.findUniqueOrThrow({ where: { id: stored.id } });
    expect(stillWrong.minutes).toBe(stored.minutes + 90);

    const fix = await recompute();
    expect(fix.seasonStats.updated).toBe(1);
    expect((await recompute({ check: true })).drifted).toEqual([]);
  });

  it('check mode reports a missing aggregate as drift', async () => {
    const check = await recompute({ check: true });
    expect(check.seasonStats.created).toBe(await db.playerSeason.count());
    expect(check.drifted).toHaveLength(await db.playerSeason.count());
    expect(await db.playerSeasonStat.count()).toBe(0);
  });

  it('keeps a player with no event rows at zero', async () => {
    // Bootstrap carries teams with no elements (R1.3) but every element has live
    // rows here; drop one player's rows to make the no-event case real.
    const ps = await db.playerSeason.findFirstOrThrow({ where: { fplId: 67 } });
    await db.playerFixtureStat.deleteMany({ where: { playerSeasonId: ps.id } });
    await db.playerGameweekStat.deleteMany({ where: { playerSeasonId: ps.id } });

    await recompute();
    const stat = await db.playerSeasonStat.findUniqueOrThrow({
      where: { playerSeasonId: ps.id },
    });
    expect(stat).toMatchObject({ appearances: 0, minutes: 0, starts: 0, totalPoints: 0 });
    expect(stat.expectedGoals.toString()).toBe('0');
  });
});
