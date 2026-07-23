// The pure half of R1.3. No database, no network.

import { describe, it, expect } from 'vitest';
import { parseFixtures } from '@/lib/fpl';
import type { FplFixture } from '@/lib/fpl';
import { FixturesPlanError, planFixtures } from '@/lib/ingest';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';

const payload = parseFixtures(fixturesSample);
const plan = planFixtures(payload);

function mutated(edit: (draft: FplFixture[]) => void): FplFixture[] {
  const draft = structuredClone(payload);
  edit(draft);
  return draft;
}

describe('planFixtures', () => {
  it('plans every fixture in the payload', () => {
    expect(plan.fixtures).toHaveLength(payload.length);
    expect(plan.warnings).toEqual([]);
  });

  it('keeps the season-scoped ids that sync resolves', () => {
    const opener = plan.fixtures.find((f) => f.fplId === 1);
    expect(opener).toMatchObject({
      code: 2561895,
      gameweekNumber: 1,
      homeClubFplId: 12,
      awayClubFplId: 4,
      homeScore: 4,
      awayScore: 2,
      finished: true,
      started: true,
      minutes: 90,
      kickoffTime: new Date('2025-08-15T19:00:00.000Z'),
    });
  });

  it('carries a fixture FPL has not scheduled yet', () => {
    const unscheduled = plan.fixtures.find((f) => f.gameweekNumber === null);
    expect(unscheduled).toBeDefined();
    // Storing it rather than skipping it: the match exists, it has two clubs,
    // and it gains a gameweek later. Skipping would make it invisible until
    // then, and would leave any coverage check silently short.
    expect(unscheduled!.kickoffTime).toBeNull();
    expect(unscheduled!.homeScore).toBeNull();
    expect(unscheduled!.finished).toBe(false);
  });

  it('preserves the difficulty ratings R7.1 will price off', () => {
    for (const fixture of plan.fixtures) {
      expect(fixture.homeDifficulty).toBeGreaterThan(0);
      expect(fixture.awayDifficulty).toBeGreaterThan(0);
    }
  });

  it('covers a double gameweek without collapsing it', () => {
    // GW33 is a real double gameweek in 25/26 — six fixtures in the sample.
    const gw33 = plan.fixtures.filter((f) => f.gameweekNumber === 33);
    expect(gw33.length).toBeGreaterThan(1);
    expect(new Set(gw33.map((f) => f.fplId)).size).toBe(gw33.length);
  });
});

describe('planFixtures integrity checks', () => {
  it('rejects a duplicate fixture id', () => {
    expect(() => planFixtures(mutated((d) => void (d[1].id = d[0].id)))).toThrow(
      /id is not unique/,
    );
  });

  it('rejects a duplicate match code', () => {
    expect(() => planFixtures(mutated((d) => void (d[1].code = d[0].code)))).toThrow(
      /code \d+ is not unique/,
    );
  });

  it('rejects a club playing itself', () => {
    expect(() => planFixtures(mutated((d) => void (d[0].team_a = d[0].team_h)))).toThrow(
      /listed as both home and away/,
    );
  });

  it('rejects a half-populated scoreline', () => {
    expect(() => planFixtures(mutated((d) => void (d[0].team_a_score = null)))).toThrow(
      /one side has a score and the other does not/,
    );
  });

  it('rejects an unparseable kickoff time', () => {
    expect(() => planFixtures(mutated((d) => void (d[0].kickoff_time = 'Saturday')))).toThrow(
      /not a parseable timestamp/,
    );
  });

  it('reports every problem at once', () => {
    try {
      planFixtures(
        mutated((d) => {
          d[0].team_a = d[0].team_h;
          d[1].kickoff_time = 'later';
        }),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FixturesPlanError);
      expect((error as FixturesPlanError).issues).toHaveLength(2);
    }
  });

  it('warns rather than fails on the states FPL passes through', () => {
    // A match briefly reports finished before started flips, and a postponed
    // match loses its event. Neither should stop an hourly cron.
    const wobbly = planFixtures(
      mutated((d) => {
        d[0].started = false;
        d[1].event = null;
      }),
    );
    expect(wobbly.fixtures).toHaveLength(payload.length);
    expect(wobbly.warnings).toEqual([
      'fixture 1: marked finished but not started',
      'fixture 7: finished but not attached to a gameweek',
    ]);
  });
});
