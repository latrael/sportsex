// The pure half of R1.2: a parsed bootstrap-static payload becomes rows.
// No database, no network — the same trimmed 25/26 fixture the parser tests use.

import { describe, it, expect } from 'vitest';
import { parseBootstrapStatic } from '@/lib/fpl';
import type { FplBootstrapStatic } from '@/lib/fpl';
import { BootstrapPlanError, deriveSeason, planBootstrap } from '@/lib/ingest';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';

const payload = parseBootstrapStatic(bootstrapSample);
const plan = planBootstrap(payload);

/** Deep-clone the fixture so a test can corrupt one field in isolation. */
function mutated(edit: (draft: FplBootstrapStatic) => void): FplBootstrapStatic {
  const draft = structuredClone(payload);
  edit(draft);
  return draft;
}

describe('deriveSeason', () => {
  it('names the season from the earliest gameweek deadline', () => {
    expect(deriveSeason(payload.events)).toEqual({ name: '2025/26', startYear: 2025 });
  });

  it('dates a season from a second-half deadline too', () => {
    // Only GW38 survives: a May 2026 deadline still belongs to 2025/26.
    const events = payload.events.filter((e) => e.id === 38);
    expect(events).toHaveLength(1);
    expect(deriveSeason(events)).toEqual({ name: '2025/26', startYear: 2025 });
  });

  it('treats July as the start of the new season', () => {
    const july = [{ ...payload.events[0], deadline_time: '2026-07-31T17:30:00Z' }];
    const june = [{ ...payload.events[0], deadline_time: '2026-06-30T17:30:00Z' }];
    expect(deriveSeason(july).name).toBe('2026/27');
    expect(deriveSeason(june).name).toBe('2025/26');
  });

  it('pads the second year: 2099/00', () => {
    const events = [{ ...payload.events[0], deadline_time: '2099-08-15T17:30:00Z' }];
    expect(deriveSeason(events)).toEqual({ name: '2099/00', startYear: 2099 });
  });

  it('refuses to guess when no event carries a deadline', () => {
    const events = payload.events.map((e) => ({ ...e, deadline_time: null }));
    expect(() => deriveSeason(events)).toThrow(BootstrapPlanError);
  });
});

describe('planBootstrap', () => {
  it('plans every club, player and gameweek in the payload', () => {
    expect(plan.season).toEqual({ name: '2025/26', startYear: 2025 });
    expect(plan.clubs).toHaveLength(payload.teams.length);
    expect(plan.players).toHaveLength(payload.elements.length);
    expect(plan.gameweeks).toHaveLength(payload.events.length);
    expect(plan.warnings).toEqual([]);
  });

  it('splits a club into stable identity and season-scoped membership', () => {
    const liverpool = plan.clubs.find((c) => c.identity.shortName === 'LIV');
    expect(liverpool).toBeDefined();
    // `code` is the identity; `id` is the season-scoped handle.
    expect(liverpool!.identity).toEqual({
      fplCode: 14,
      pulseId: 10,
      name: 'Liverpool',
      shortName: 'LIV',
    });
    expect(liverpool!.season.fplId).toBe(12);
    expect(liverpool!.season.strengthAttackHome).toBeGreaterThan(0);
  });

  it('keys a player on code and opta_code, never on a name', () => {
    const salah = plan.players.find((p) => p.identity.fplCode === 118748);
    expect(salah).toBeDefined();
    expect(salah!.identity.optaCode).toBe('p118748');
    expect(salah!.season.fplId).toBe(381);
    // element.team 12 → Liverpool, resolved through the club's stable code.
    expect(salah!.clubFplCode).toBe(14);
  });

  it('reads position from the element type short name, not its id', () => {
    const byShortName = new Map(
      payload.element_types.map((t) => [t.id, t.singular_name_short]),
    );
    for (const element of payload.elements) {
      const planned = plan.players.find((p) => p.season.fplId === element.id);
      expect(planned!.season.position).toBe(byShortName.get(element.element_type));
    }
  });

  it('parses dates at UTC midnight and keeps the nulls FPL actually sends', () => {
    const petrovic = plan.players.find((p) => p.season.fplId === 67);
    expect(petrovic!.identity.birthDate).toEqual(new Date('1999-10-08T00:00:00.000Z'));
    expect(petrovic!.season.teamJoinDate).toEqual(new Date('2025-07-16T00:00:00.000Z'));
    // squad_number is null for all 841 players in 25/26 — see R1.2's note.
    expect(plan.players.every((p) => p.season.squadNumber === null)).toBe(true);
  });

  it('leaves selected_by_percent as the string the wire carried', () => {
    for (const player of plan.players) {
      expect(typeof player.season.selectedByPercent).toBe('string');
    }
  });

  it('carries the gameweek settlement flags R6.4 will settle on', () => {
    const gw1 = plan.gameweeks.find((g) => g.number === 1);
    expect(gw1).toMatchObject({
      name: 'Gameweek 1',
      finished: true,
      dataChecked: true,
      deadlineTime: new Date('2025-08-15T17:30:00.000Z'),
      averageEntryScore: 54,
      highestScore: 127,
    });
  });

  it('accepts an explicit season instead of deriving one', () => {
    const forced = planBootstrap(payload, { season: { name: '2026/27', startYear: 2026 } });
    expect(forced.season).toEqual({ name: '2026/27', startYear: 2026 });
  });
});

describe('planBootstrap integrity checks', () => {
  it('rejects an element pointing at a team that is not in the payload', () => {
    const bad = mutated((d) => {
      d.elements[0].team = 99;
    });
    expect(() => planBootstrap(bad)).toThrow(/team 99 is not in this payload/);
  });

  it('rejects an unknown element type', () => {
    const bad = mutated((d) => {
      d.elements[0].element_type = 9;
    });
    expect(() => planBootstrap(bad)).toThrow(/element_type 9 is not in this payload/);
  });

  it('rejects a position short name it does not recognise', () => {
    const bad = mutated((d) => {
      d.element_types[0].singular_name_short = 'KEEP';
    });
    expect(() => planBootstrap(bad)).toThrow(/unknown position "KEEP"/);
  });

  it('rejects duplicate player codes', () => {
    const bad = mutated((d) => {
      d.elements[1].code = d.elements[0].code;
    });
    expect(() => planBootstrap(bad)).toThrow(/code \d+ is not unique/);
  });

  it('rejects duplicate opta codes', () => {
    const bad = mutated((d) => {
      d.elements[1].opta_code = d.elements[0].opta_code;
    });
    expect(() => planBootstrap(bad)).toThrow(/opta_code \S+ is not unique/);
  });

  it('rejects duplicate club codes', () => {
    const bad = mutated((d) => {
      d.teams[1].code = d.teams[0].code;
    });
    expect(() => planBootstrap(bad)).toThrow(/two teams share code/);
  });

  it('rejects a date in a format FPL has never used', () => {
    const bad = mutated((d) => {
      d.elements[0].birth_date = '08/10/1999';
    });
    expect(() => planBootstrap(bad)).toThrow(/expected a YYYY-MM-DD date/);
  });

  it('reports every problem at once, not just the first', () => {
    const bad = mutated((d) => {
      d.elements[0].team = 99;
      d.elements[1].element_type = 9;
    });
    try {
      planBootstrap(bad);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BootstrapPlanError);
      expect((error as BootstrapPlanError).issues).toHaveLength(2);
    }
  });

  it('warns but does not fail when team_code contradicts team', () => {
    // What a mid-transfer payload looks like. Failing here would take the daily
    // cron down for one inconsistent row.
    const wobbly = mutated((d) => {
      d.elements[0].team_code = 999;
    });
    const planned = planBootstrap(wobbly);
    expect(planned.players).toHaveLength(payload.elements.length);
    expect(planned.warnings).toHaveLength(1);
    expect(planned.warnings[0]).toMatch(/team_code says 999; using team/);
  });
});
