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
import { syncSeasonFairValues } from '@/lib/valuation';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';
import gw1Sample from '../fixtures/fpl/event-1-live.sample.json';
import gw33Sample from '../fixtures/fpl/event-33-live.sample.json';

const bootstrap = parseBootstrapStatic(bootstrapSample);
const fixtures = parseFixtures(fixturesSample);
const gw1 = parseEventLive(gw1Sample);
const gw33 = parseEventLive(gw33Sample);

beforeEach(async () => {
  await cleanDb();
  await syncBootstrap(db, planBootstrap(bootstrap));
  await syncFixtures(db, planFixtures(fixtures), { startYear: 2025 });
  await syncEventLive(db, planEventLive(gw1), { startYear: 2025, gameweekNumber: 1 });
  await syncEventLive(db, planEventLive(gw33), { startYear: 2025, gameweekNumber: 33 });
});

describe('syncSeasonFairValues (Phase 3 DB integration)', () => {
  it('creates Asset rows, writes FairValue + PriceTick rows, and is idempotent on re-run', async () => {
    const first = await syncSeasonFairValues(db, { startYear: 2025, gameweekNumber: 1 });
    const playerCount = await db.playerSeason.count();
    const clubCount = await db.clubSeason.count();

    expect(first.assetsCreated).toBe(playerCount + clubCount);
    expect(first.fairValuesWritten).toBe(playerCount + clubCount);
    expect(first.priceTicksWritten).toBe(playerCount + clubCount);

    // Every FairValue is within [10, 1500]
    const fvs = await db.fairValue.findMany();
    expect(fvs).toHaveLength(playerCount + clubCount);
    for (const fv of fvs) {
      const val = Number(fv.value);
      expect(val).toBeGreaterThanOrEqual(10);
      expect(val).toBeLessThanOrEqual(1500);
    }

    // Re-running for the same gameweek creates 0 new assets and leaves row counts identical
    const second = await syncSeasonFairValues(db, { startYear: 2025, gameweekNumber: 1 });
    expect(second.assetsCreated).toBe(0);
    expect(await db.fairValue.count()).toBe(playerCount + clubCount);
    expect(await db.priceTick.count()).toBe(playerCount + clubCount);
  });
});
