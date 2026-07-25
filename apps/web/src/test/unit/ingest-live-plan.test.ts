// The pure half of R1.4. No database, no network.
//
// The case that matters is the double gameweek: one element with two `explain`
// entries has to become two fixture rows carrying only that fixture's stats,
// while the gameweek-only stats (xG, bps, …) stay a single combined total.

import { describe, it, expect } from 'vitest';
import { parseEventLive } from '@/lib/fpl';
import type { FplEventLive } from '@/lib/fpl';
import { EventLivePlanError, planEventLive } from '@/lib/ingest';
import gw1Sample from '../fixtures/fpl/event-1-live.sample.json';
import gw33Sample from '../fixtures/fpl/event-33-live.sample.json';

const gw1 = parseEventLive(gw1Sample);
const gw33 = parseEventLive(gw33Sample);

function mutated(source: FplEventLive, edit: (draft: FplEventLive) => void): FplEventLive {
  const draft = structuredClone(source);
  edit(draft);
  return draft;
}

describe('planEventLive', () => {
  it('plans one gameweek-stat row per element and one fixture-stat row per explain entry', () => {
    const plan = planEventLive(gw33);
    expect(plan.gameweekStats).toHaveLength(gw33.elements.length); // 20
    expect(plan.fixtureStats).toHaveLength(
      gw33.elements.reduce((n, e) => n + e.explain.length, 0), // 34
    );
    expect(plan.warnings).toEqual([]);
  });

  it('splits a double gameweek into two fixture rows with per-fixture stats', () => {
    const plan = planEventLive(gw33);
    const rows = plan.fixtureStats.filter((s) => s.playerFplId === 67);

    // Element 67 played both fixtures 328 and 332 in GW33.
    expect(rows.map((r) => r.fixtureFplId).sort()).toEqual([328, 332]);

    const f328 = rows.find((r) => r.fixtureFplId === 328)!;
    const f332 = rows.find((r) => r.fixtureFplId === 332)!;

    // Fixture 328: 90 minutes and a yellow card (2 - 1 = 1 point).
    expect(f328).toMatchObject({ minutes: 90, yellowCards: 1, goalsConceded: 0, totalPoints: 1 });
    // Fixture 332: 90 minutes, conceded 2 (2 - 1 = 1 point).
    expect(f332).toMatchObject({ minutes: 90, yellowCards: 0, goalsConceded: 2, totalPoints: 1 });

    // The two per-fixture point totals add up to the gameweek total.
    const gw = plan.gameweekStats.find((s) => s.playerFplId === 67)!;
    expect(f328.totalPoints + f332.totalPoints).toBe(gw.totalPoints);
  });

  it('keeps the gameweek-only model inputs as a single combined total, not a split', () => {
    const plan = planEventLive(gw33);
    const gw = plan.gameweekStats.find((s) => s.playerFplId === 67)!;

    // These live only at gameweek grain, as the strings the wire carried.
    expect(gw.minutes).toBe(180); // 90 + 90 across the double
    expect(gw.starts).toBe(2);
    expect(gw.expectedGoalsConceded).toBe('2.42');
    expect(typeof gw.bps).toBe('number');

    // No fixture row carries an xGC column at all — nothing fabricates a split.
    expect(plan.fixtureStats[0]).not.toHaveProperty('expectedGoalsConceded');
  });

  it('reconciles a single-fixture gameweek to one fixture row equal to the total', () => {
    const plan = planEventLive(gw1);
    expect(plan.fixtureStats).toHaveLength(gw1.elements.length); // no doubles
    expect(plan.warnings).toEqual([]);

    const keeper = plan.fixtureStats.find((s) => s.playerFplId === 67)!;
    expect(keeper).toMatchObject({ fixtureFplId: 1, minutes: 90, saves: 6 });
  });

  it('warns when explain minutes disagree with the gameweek total', () => {
    const plan = planEventLive(
      mutated(gw1, (d) => {
        const el = d.elements.find((e) => e.id === 67)!;
        el.stats.minutes = 45; // explain still says 90
      }),
    );
    expect(plan.warnings).toEqual([
      expect.stringContaining('explain minutes (90) disagree with the gameweek total (45)'),
    ]);
  });

  it('warns when a player has recorded minutes but no explain entries', () => {
    const plan = planEventLive(
      mutated(gw1, (d) => {
        const el = d.elements.find((e) => e.id === 67)!;
        el.explain = [];
      }),
    );
    expect(plan.warnings).toEqual([expect.stringContaining('90 minutes but no explain entries')]);
  });

  it('surfaces an unmapped explain identifier as a warning instead of dropping it', () => {
    const plan = planEventLive(
      mutated(gw1, (d) => {
        const el = d.elements.find((e) => e.id === 67)!;
        el.explain[0].stats.push({ identifier: 'penalties_conceded', points: -1, value: 1 });
      }),
    );
    expect(plan.warnings).toEqual([
      expect.stringContaining('unmapped explain identifier "penalties_conceded"'),
    ]);
    // The unknown identifier's points still count toward the fixture total.
    const row = plan.fixtureStats.find((s) => s.playerFplId === 67)!;
    expect(row.totalPoints).toBe(gw1.elements.find((e) => e.id === 67)!.stats.total_points - 1);
  });

  it('throws when one element lists the same fixture twice', () => {
    expect(() =>
      planEventLive(
        mutated(gw33, (d) => {
          const el = d.elements.find((e) => e.id === 67)!;
          el.explain[1].fixture = el.explain[0].fixture; // duplicate
        }),
      ),
    ).toThrow(EventLivePlanError);
  });

  it('throws when an element id appears more than once', () => {
    expect(() =>
      planEventLive(
        mutated(gw1, (d) => {
          d.elements.push(structuredClone(d.elements[0]));
        }),
      ),
    ).toThrow(/appears more than once/);
  });
});
