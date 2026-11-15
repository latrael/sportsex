import { describe, it, expect } from 'vitest';
import {
  computeFixtureOdds,
  simulateSeasonPredictionBook,
  type SimulatedFixtureForOdds,
} from '@/lib/predictions/odds';
import { simulate30DayEconomy } from '@/lib/economy/simulate30d';
import season2526Fixtures from '../fixtures/fpl/season-2526-fixtures.json';

describe('R7.1 — Real Prediction Odds (Poisson + Dixon-Coles with 5% house margin)', () => {
  it('computes sensible odds for favourites, underdogs, and preseason null strengths', () => {
    const strongHome = computeFixtureOdds({
      homeStrengthAttack: 1350,
      homeStrengthDefence: 1340,
      awayStrengthAttack: 1080,
      awayStrengthDefence: 1070,
    });
    expect(strongHome.odds.H).toBeLessThan(1.55);
    expect(strongHome.odds.A).toBeGreaterThan(5.0);
    expect(strongHome.expectedHouseEdge).toBeGreaterThanOrEqual(0.045);
    expect(strongHome.expectedHouseEdge).toBeLessThanOrEqual(0.055);

    // Preseason null strength fallback (R1.1 compatibility)
    const preseason = computeFixtureOdds({
      homeStrengthAttack: null,
      homeStrengthDefence: null,
      awayStrengthAttack: null,
      awayStrengthDefence: null,
    });
    expect(preseason.odds.H).toBeGreaterThan(1.8);
    expect(preseason.odds.H).toBeLessThan(2.4);
    expect(preseason.odds.A).toBeGreaterThan(preseason.odds.H);
  });

  it('simulated over all 380 fixtures of 25/26, the house edge is positive and within 1pp of the 5% target', () => {
    const simFixtures = season2526Fixtures as SimulatedFixtureForOdds[];
    expect(simFixtures).toHaveLength(380);

    const sim = simulateSeasonPredictionBook(simFixtures, { houseMargin: 0.05 });

    // Realized house edge is positive and within 1pp of the 5% target ([4.0%, 6.0%])
    expect(sim.realizedHouseEdge).toBeGreaterThanOrEqual(0.04);
    expect(sim.realizedHouseEdge).toBeLessThanOrEqual(0.06);

    // By contrast, the old flat 2.0x payout had a deeply negative house edge (player +EV)
    expect(sim.oldFlat2xHouseEdge).toBeLessThan(-0.05);
  });
});

describe('R7.3 — 30-day Economy Simulation (Trading Fees as Primary Coin Sink)', () => {
  it('simulated 30-day economy is net-neutral or mildly deflationary with trading fees as primary sink', () => {
    const sim = simulate30DayEconomy();

    expect(sim.days).toBe(30);
    expect(sim.userCount).toBe(100);
    // Trading fees are the primary coin sink (>70% of total sinks)
    expect(sim.tradingFeeSinkShare).toBeGreaterThan(0.7);
    // Net 30-day supply change is net-neutral or mildly deflationary ([-5.0%, +0.5%])
    expect(sim.netInflationPct).toBeLessThanOrEqual(0.5);
    expect(sim.netInflationPct).toBeGreaterThanOrEqual(-5.0);
  });
});
