// The database half of R1.3: fixtures resolve to real clubs and gameweeks, and
// a match that gets played updates in place rather than duplicating.

import { describe, it, expect, beforeEach } from 'vitest';
import { db, cleanDb } from '../helpers';
import { parseBootstrapStatic, parseFixtures } from '@/lib/fpl';
import type { FplFixture } from '@/lib/fpl';
import { FixturesSyncError, planBootstrap, planFixtures, syncBootstrap, syncFixtures } from '@/lib/ingest';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';

const bootstrap = parseBootstrapStatic(bootstrapSample);
const payload = parseFixtures(fixturesSample);
const FIXTURES = payload.length; // 10, one of them unscheduled

function mutated(edit: (draft: FplFixture[]) => void): FplFixture[] {
  const draft = structuredClone(payload);
  edit(draft);
  return draft;
}

function sync(source: FplFixture[] = payload) {
  return syncFixtures(db, planFixtures(source), { startYear: 2025 });
}

beforeEach(async () => {
  await cleanDb();
});

describe('syncFixtures — ordering', () => {
  it('refuses to run before bootstrap-static has created the season', async () => {
    await expect(sync()).rejects.toThrow(FixturesSyncError);
    await expect(sync()).rejects.toThrow(/ingest bootstrap-static first/);
  });

  it('reports the missing reference rows instead of writing a partial matchweek', async () => {
    await syncBootstrap(db, planBootstrap(bootstrap));
    // A club that never appeared in bootstrap-static.
    const orphaned = mutated((d) => void (d[0].team_h = 77));

    await expect(sync(orphaned)).rejects.toThrow(/no home club with fplId 77 in 2025/);
    expect(await db.fixture.count()).toBe(0);
  });
});

describe('syncFixtures', () => {
  beforeEach(async () => {
    await syncBootstrap(db, planBootstrap(bootstrap));
  });

  it('creates every fixture and links it to two clubs and a gameweek', async () => {
    const result = await sync();

    expect(result.fixtures).toEqual({ created: FIXTURES, updated: 0, unchanged: 0 });
    expect(result.unscheduled).toBe(1);
    expect(result.season.startYear).toBe(2025);

    const opener = await db.fixture.findFirst({
      where: { fplId: 1 },
      include: { homeClub: { include: { club: true } }, awayClub: { include: { club: true } }, gameweek: true },
    });

    expect(opener!.homeClub.club.shortName).toBe('LIV');
    expect(opener!.awayClub.club.shortName).toBe('BOU');
    expect(opener!.gameweek!.number).toBe(1);
    expect(opener!.homeScore).toBe(4);
    expect(opener!.awayScore).toBe(2);
    expect(opener!.kickoffTime).toEqual(new Date('2025-08-15T19:00:00.000Z'));
  });

  it('stores an unscheduled fixture with a null gameweek', async () => {
    await sync();

    const unscheduled = await db.fixture.findMany({ where: { gameweekId: null } });
    expect(unscheduled).toHaveLength(1);
    expect(unscheduled[0].homeClubSeasonId).toBeGreaterThan(0);
    expect(unscheduled[0].awayClubSeasonId).toBeGreaterThan(0);
  });

  it('writes nothing on a re-run (R1.7)', async () => {
    await sync();
    const second = await sync();
    expect(second.fixtures).toEqual({ created: 0, updated: 0, unchanged: FIXTURES });

    const before = await db.fixture.findMany({ orderBy: { fplId: 'asc' } });
    await sync();
    expect(await db.fixture.findMany({ orderBy: { fplId: 'asc' } })).toEqual(before);
  });

  it('updates the same row as a match is played', async () => {
    // Ingest the calendar as it looks before kickoff...
    const scheduled = mutated((d) => {
      for (const fixture of d) {
        if (fixture.event === null) continue; // leave the unscheduled one alone
        fixture.started = false;
        fixture.finished = false;
        fixture.finished_provisional = false;
        fixture.minutes = 0;
        fixture.team_h_score = null;
        fixture.team_a_score = null;
      }
    });
    const first = await sync(scheduled);
    expect(first.fixtures.created).toBe(FIXTURES);
    const created = await db.fixture.findFirst({ where: { fplId: 1 } });

    // ...then as it looks once the results are in.
    const played = await sync();
    expect(played.fixtures.created).toBe(0);
    expect(played.fixtures.updated).toBe(FIXTURES - 1); // the unscheduled one never moved

    const settled = await db.fixture.findFirst({ where: { fplId: 1 } });
    expect(settled!.id).toBe(created!.id);
    expect(settled!.code).toBe(created!.code);
    expect(settled!.homeScore).toBe(4);
    expect(settled!.finished).toBe(true);
  });

  it('follows a postponed fixture into its new gameweek', async () => {
    await sync();
    const before = await db.fixture.findFirst({ where: { fplId: 1 } });

    const rescheduled = await sync(
      mutated((d) => {
        const fixture = d.find((f) => f.id === 1)!;
        fixture.event = 33;
        fixture.kickoff_time = '2026-04-25T14:00:00Z';
      }),
    );
    expect(rescheduled.fixtures).toEqual({ created: 0, updated: 1, unchanged: FIXTURES - 1 });

    const after = await db.fixture.findFirst({ where: { fplId: 1 }, include: { gameweek: true } });
    expect(after!.id).toBe(before!.id);
    expect(after!.gameweek!.number).toBe(33);
  });

  it('picks up a fixture that gets scheduled for the first time', async () => {
    await sync();

    const scheduled = await sync(
      mutated((d) => {
        const fixture = d.find((f) => f.event === null)!;
        fixture.event = 38;
        fixture.kickoff_time = '2026-05-24T15:00:00Z';
      }),
    );
    expect(scheduled.unscheduled).toBe(0);
    expect(scheduled.fixtures).toEqual({ created: 0, updated: 1, unchanged: FIXTURES - 1 });
    expect(await db.fixture.count({ where: { gameweekId: null } })).toBe(0);
  });

  it('refuses two seasons sharing one match code', async () => {
    await sync();

    // 26/27, built the way the rollover test in ingest-bootstrap does.
    const nextBootstrap = structuredClone(bootstrap);
    for (const team of nextBootstrap.teams) team.id += 50;
    for (const element of nextBootstrap.elements) {
      element.id += 1000;
      element.team += 50;
    }
    for (const event of nextBootstrap.events) {
      event.deadline_time = event.deadline_time!.replace(/^\d{4}/, (y) => String(Number(y) + 1));
    }
    await syncBootstrap(db, planBootstrap(nextBootstrap));

    // Same match codes, renumbered teams: what a code collision would look like.
    const nextFixtures = mutated((d) => {
      for (const fixture of d) {
        fixture.team_h += 50;
        fixture.team_a += 50;
      }
    });

    await expect(
      syncFixtures(db, planFixtures(nextFixtures), { startYear: 2026 }),
    ).rejects.toThrow(/Unique constraint failed/);
  });
});
