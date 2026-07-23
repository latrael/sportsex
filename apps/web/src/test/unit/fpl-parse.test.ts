// Parses checked-in payload fixtures. No network.
//
// The fixture files are genuine FPL responses from the 25/26 season, trimmed to
// a referentially closed subset: every `element.team` resolves to a team in the
// file, and every `explain[].fixture` in the live payloads resolves to a fixture
// in fixtures.sample.json.

import { describe, it, expect } from 'vitest';
import {
  FplParseError,
  parseBootstrapStatic,
  parseByEndpoint,
  parseEventLive,
  parseFixtures,
} from '@/lib/fpl';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';
import live1Sample from '../fixtures/fpl/event-1-live.sample.json';
import live33Sample from '../fixtures/fpl/event-33-live.sample.json';

describe('parseBootstrapStatic', () => {
  const boot = parseBootstrapStatic(bootstrapSample);

  it('parses teams, element types, events and elements', () => {
    expect(boot.teams.map((t) => t.id)).toEqual([4, 11, 12, 13]);
    expect(boot.element_types.map((t) => t.singular_name_short)).toEqual([
      'GKP',
      'DEF',
      'MID',
      'FWD',
    ]);
    expect(boot.events.map((e) => e.id)).toEqual([1, 33, 38]);
    expect(boot.elements.length).toBeGreaterThan(0);
  });

  it('keeps the stable identifiers R1.2 keys on', () => {
    const salah = boot.elements.find((e) => e.id === 381);
    expect(salah).toBeDefined();
    expect(salah!.code).toBe(118748);
    expect(salah!.opta_code).toBe('p118748');
    expect(salah!.team).toBe(12);
    expect(salah!.element_type).toBe(3);
  });

  it('keeps decimal fields as strings rather than coercing to float', () => {
    const salah = boot.elements.find((e) => e.id === 381)!;
    expect(salah.expected_goals).toBe('8.23');
    expect(typeof salah.selected_by_percent).toBe('string');
  });

  it('accepts the nulls the API actually sends', () => {
    // squad_number is declared by the API but null for every player in 25/26,
    // and birth_date is null for a minority. Both must be nullable in the
    // schema R1.2 writes, or ingestion drops real players.
    expect(boot.elements.every((e) => e.squad_number === null)).toBe(true);
    const injured = boot.elements.find((e) => e.status === 'i');
    expect(injured).toBeDefined();
    expect(injured!.chance_of_playing_next_round).toBe(0);
  });

  it('carries availability signals through', () => {
    const statuses = new Set(boot.elements.map((e) => e.status));
    expect(statuses.has('a')).toBe(true);
    expect(statuses.has('i')).toBe(true);
  });

  it('every element resolves to a team and an element type', () => {
    const teamIds = new Set(boot.teams.map((t) => t.id));
    const typeIds = new Set(boot.element_types.map((t) => t.id));
    for (const e of boot.elements) {
      expect(teamIds.has(e.team)).toBe(true);
      expect(typeIds.has(e.element_type)).toBe(true);
    }
  });

  it('preserves fields the schema does not name', () => {
    const raw = (bootstrapSample as { elements: Array<Record<string, unknown>> }).elements[0];
    const parsed = boot.elements[0] as unknown as Record<string, unknown>;
    expect(parsed.now_cost_rank).toBe(raw.now_cost_rank);
  });

  it('rejects a payload missing a required field', () => {
    const broken = { ...bootstrapSample, teams: [{ id: 1 }] };
    expect(() => parseBootstrapStatic(broken)).toThrow(FplParseError);
    try {
      parseBootstrapStatic(broken);
    } catch (error) {
      const parseError = error as FplParseError;
      expect(parseError.endpoint).toBe('bootstrap-static');
      expect(parseError.issues.length).toBeGreaterThan(0);
      expect(parseError.raw).toBe(broken);
    }
  });
});

describe('parseFixtures', () => {
  const fixtures = parseFixtures(fixturesSample);

  it('parses a finished fixture with a scoreline', () => {
    const opener = fixtures.find((f) => f.id === 1)!;
    expect(opener.event).toBe(1);
    expect(opener.finished).toBe(true);
    expect(opener.team_h).toBe(12);
    expect(opener.team_a).toBe(4);
    expect(opener.team_h_score).toBe(4);
    expect(opener.team_a_score).toBe(2);
    expect(opener.kickoff_time).toBe('2025-08-15T19:00:00Z');
  });

  it('parses an unscheduled fixture with null event, kickoff and scores', () => {
    const future = fixtures.find((f) => f.id === 999)!;
    expect(future.event).toBeNull();
    expect(future.kickoff_time).toBeNull();
    expect(future.started).toBeNull();
    expect(future.team_h_score).toBeNull();
    expect(future.team_a_score).toBeNull();
    expect(future.stats).toEqual([]);
  });

  it('parses the per-fixture stat breakdown', () => {
    const opener = fixtures.find((f) => f.id === 1)!;
    const goals = opener.stats.find((s) => s.identifier === 'goals_scored')!;
    expect(goals.h.reduce((sum, g) => sum + g.value, 0)).toBe(4);
    expect(goals.a).toEqual([{ value: 2, element: 82 }]);
  });
});

describe('parseEventLive', () => {
  const gw1 = parseEventLive(live1Sample);
  const gw33 = parseEventLive(live33Sample);

  it('parses per-player gameweek stats', () => {
    const salah = gw1.elements.find((e) => e.id === 381)!;
    expect(salah.stats.minutes).toBeGreaterThan(0);
    expect(typeof salah.stats.expected_goals).toBe('string');
  });

  it('splits a double gameweek across two explain entries', () => {
    // GW33 was a genuine double for Bournemouth: fixtures 328 and 332.
    const petrovic = gw33.elements.find((e) => e.id === 67)!;
    expect(petrovic.explain.map((x) => x.fixture)).toEqual([328, 332]);
    expect(petrovic.stats.minutes).toBe(180);
    const perFixtureMinutes = petrovic.explain.map(
      (x) => x.stats.find((s) => s.identifier === 'minutes')!.value,
    );
    expect(perFixtureMinutes).toEqual([90, 90]);
    // The invariant R1.4 depends on: explain sums to the gameweek total.
    expect(perFixtureMinutes.reduce((a, b) => a + b, 0)).toBe(petrovic.stats.minutes);
  });

  it('gives a single-fixture gameweek exactly one explain entry', () => {
    const singles = gw1.elements.filter((e) => e.explain.length > 0);
    expect(singles.length).toBeGreaterThan(0);
    expect(singles.every((e) => e.explain.length === 1)).toBe(true);
  });
});

describe('parseByEndpoint', () => {
  it('replays an archived payload from its recorded endpoint', () => {
    expect(parseByEndpoint('bootstrap-static', bootstrapSample)).toEqual(
      parseBootstrapStatic(bootstrapSample),
    );
    expect(parseByEndpoint('fixtures', fixturesSample)).toEqual(parseFixtures(fixturesSample));
    expect(parseByEndpoint('event-live', live33Sample)).toEqual(parseEventLive(live33Sample));
  });
});
