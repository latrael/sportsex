// The database half of R1.4: a gameweek's live payload resolves to real players
// and fixtures, a double gameweek lands two per-fixture rows for the same
// player, the gameweek-only stats land once, and the raw payload is archived.

import { describe, it, expect, beforeEach } from 'vitest';
import { db, cleanDb } from '../helpers';
import { parseBootstrapStatic, parseEventLive, parseFixtures } from '@/lib/fpl';
import type { FplEventLive, RawPayload } from '@/lib/fpl';
import {
  EventLiveSyncError,
  planBootstrap,
  planEventLive,
  planFixtures,
  syncBootstrap,
  syncEventLive,
  syncFixtures,
} from '@/lib/ingest';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';
import gw1Sample from '../fixtures/fpl/event-1-live.sample.json';
import gw33Sample from '../fixtures/fpl/event-33-live.sample.json';

const bootstrap = parseBootstrapStatic(bootstrapSample);
const fixtures = parseFixtures(fixturesSample);
const gw1 = parseEventLive(gw1Sample);
const gw33 = parseEventLive(gw33Sample);

function mutated(source: FplEventLive, edit: (draft: FplEventLive) => void): FplEventLive {
  const draft = structuredClone(source);
  edit(draft);
  return draft;
}

function rawFor(gameweek: number, body: unknown): RawPayload {
  return {
    endpoint: 'event-live',
    url: `https://fantasy.premierleague.com/api/event/${gameweek}/live/`,
    status: 200,
    fetchedAt: new Date().toISOString(),
    bytes: 1234,
    attempts: 1,
    durationMs: 10,
    body,
  };
}

function syncGw(source: FplEventLive, gameweekNumber: number, raw?: RawPayload) {
  return syncEventLive(db, planEventLive(source), { startYear: 2025, gameweekNumber, raw });
}

beforeEach(async () => {
  await cleanDb();
});

describe('syncEventLive — ordering', () => {
  it('refuses to run before bootstrap-static has created the season', async () => {
    await expect(syncGw(gw1, 1)).rejects.toThrow(/ingest bootstrap-static first/);
  });

  it('reports an unknown fixture instead of writing a partial gameweek', async () => {
    await syncBootstrap(db, planBootstrap(bootstrap));
    await syncFixtures(db, planFixtures(fixtures), { startYear: 2025 });

    const orphaned = mutated(gw33, (d) => void (d.elements[0].explain[0].fixture = 12345));
    await expect(syncGw(orphaned, 33)).rejects.toThrow(EventLiveSyncError);
    await expect(syncGw(orphaned, 33)).rejects.toThrow(/no fixture with fplId 12345/);
    expect(await db.playerFixtureStat.count()).toBe(0);
    expect(await db.playerGameweekStat.count()).toBe(0);
  });
});

describe('syncEventLive', () => {
  beforeEach(async () => {
    await syncBootstrap(db, planBootstrap(bootstrap));
    await syncFixtures(db, planFixtures(fixtures), { startYear: 2025 });
  });

  it('splits a double gameweek into two rows with correctly split stats (R1.4 accept)', async () => {
    const result = await syncGw(gw33, 33);

    expect(result.fixtureStats.created).toBe(34);
    expect(result.gameweekStats.created).toBe(gw33.elements.length); // 20
    expect(result.warnings).toEqual([]);

    // Element 67 is season-scoped fplId 67; resolve through player_season.
    const ps = await db.playerSeason.findFirst({
      where: { seasonId: result.season.id, fplId: 67 },
    });
    const rows = await db.playerFixtureStat.findMany({
      where: { playerSeasonId: ps!.id },
      include: { fixture: true },
      orderBy: { fixture: { fplId: 'asc' } },
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.fixture.fplId)).toEqual([328, 332]);
    expect(rows[0]).toMatchObject({ minutes: 90, yellowCards: 1, totalPoints: 1 });
    expect(rows[1]).toMatchObject({ minutes: 90, goalsConceded: 2, totalPoints: 1 });
    // Every fixture row is stamped with the gameweek it was ingested under.
    expect(rows.every((r) => r.gameweekId === result.gameweek.id)).toBe(true);

    // The gameweek-only line exists exactly once and carries the combined total.
    const gwRows = await db.playerGameweekStat.findMany({ where: { playerSeasonId: ps!.id } });
    expect(gwRows).toHaveLength(1);
    expect(gwRows[0].minutes).toBe(180);
    expect(gwRows[0].expectedGoalsConceded.toString()).toBe('2.42');
  });

  it('writes nothing on a re-run (R1.7)', async () => {
    await syncGw(gw33, 33);
    const second = await syncGw(gw33, 33);
    expect(second.fixtureStats).toEqual({ created: 0, updated: 0, unchanged: 34 });
    expect(second.gameweekStats).toEqual({ created: 0, updated: 0, unchanged: 20 });

    const before = await db.playerFixtureStat.findMany({ orderBy: { id: 'asc' } });
    await syncGw(gw33, 33);
    expect(await db.playerFixtureStat.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('updates in place when a live stat moves during a gameweek', async () => {
    await syncGw(gw33, 33);

    const bumped = mutated(gw33, (d) => {
      const el = d.elements.find((e) => e.id === 67)!;
      el.explain[0].stats.find((s) => s.identifier === 'yellow_cards')!.value = 2;
    });
    const result = await syncGw(bumped, 33);
    expect(result.fixtureStats.updated).toBe(1);
    expect(result.fixtureStats.created).toBe(0);

    const ps = await db.playerSeason.findFirst({ where: { fplId: 67 } });
    const row = await db.playerFixtureStat.findFirst({
      where: { playerSeasonId: ps!.id, fixture: { fplId: 328 } },
    });
    expect(row!.yellowCards).toBe(2);
  });

  it('handles a single-fixture gameweek', async () => {
    const result = await syncGw(gw1, 1);
    expect(result.fixtureStats.created).toBe(gw1.elements.length);
    expect(result.gameweekStats.created).toBe(gw1.elements.length);

    // No player has two rows in a single gameweek.
    const grouped = await db.playerFixtureStat.groupBy({
      by: ['playerSeasonId'],
      _count: true,
      having: { playerSeasonId: { _count: { gt: 1 } } },
    });
    expect(grouped).toHaveLength(0);
  });

  it('archives the raw payload and skips rewriting it when byte-identical (R1.7)', async () => {
    const first = await syncGw(gw33, 33, rawFor(33, gw33Sample));
    expect(first.raw).toBe('created');

    const stored = await db.rawPayload.findUnique({
      where: { endpoint_scopeKey: { endpoint: 'event-live', scopeKey: '2025:gw33' } },
    });
    expect(stored).not.toBeNull();

    // Same body, later fetch metadata → no rewrite.
    const second = await syncGw(gw33, 33, rawFor(33, gw33Sample));
    expect(second.raw).toBe('unchanged');
    expect(await db.rawPayload.count()).toBe(1);
  });

  it('keeps two gameweeks side by side', async () => {
    await syncGw(gw1, 1);
    await syncGw(gw33, 33);

    const gw1Id = (await db.gameweek.findFirst({ where: { number: 1 } }))!.id;
    const gw33Id = (await db.gameweek.findFirst({ where: { number: 33 } }))!.id;

    expect(await db.playerFixtureStat.count({ where: { gameweekId: gw1Id } })).toBe(18);
    expect(await db.playerFixtureStat.count({ where: { gameweekId: gw33Id } })).toBe(34);
  });
});
