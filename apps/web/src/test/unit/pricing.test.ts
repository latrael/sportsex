import { describe, it, expect } from 'vitest';
import {
  seedPrice,
  demandMultiplier,
  livePrice,
  applyMatchToPrice,
  teamPrice,
} from '@/lib/pricing';

describe('seedPrice', () => {
  it('returns 50 for a player with no stats', () => {
    const p = seedPrice({ goals: 0, assists: 0, minutes: 0, predGA90Next: null });
    expect(p).toBe(50);
  });

  it('adds productivity component correctly', () => {
    // goals*5 + assists*3 = 10*5 + 5*3 = 65. minutesFactor = min(500/1000,3)*10 = 5. Total = 50+65+5 = 120
    const p = seedPrice({ goals: 10, assists: 5, minutes: 500, predGA90Next: null });
    expect(p).toBe(120);
  });

  it('caps minutesFactor at 30 (3000+ minutes)', () => {
    const p = seedPrice({ goals: 0, assists: 0, minutes: 9999, predGA90Next: null });
    expect(p).toBe(80); // 50 + 0 + 30
  });

  it('adds projection bump when predGA90Next is given', () => {
    // 50 + 0 + 0 + 2.0*20 = 90
    const p = seedPrice({ goals: 0, assists: 0, minutes: 0, predGA90Next: 2.0 });
    expect(p).toBe(90);
  });

  it('clamps minimum to 5', () => {
    const p = seedPrice({ goals: 0, assists: 0, minutes: 0, predGA90Next: -100 });
    expect(p).toBe(5);
  });

  it('clamps maximum to PRICE_CAP (2000)', () => {
    // goals*5 + assists*3 + minutesFactor(30) + predGA90Next*20 would far exceed 2000
    const p = seedPrice({ goals: 200, assists: 200, minutes: 9999, predGA90Next: 100 });
    expect(p).toBe(2000);
  });
});

describe('demandMultiplier', () => {
  it('returns 1.0 at zero net buys', () => {
    expect(demandMultiplier(0)).toBeCloseTo(1.0);
  });

  it('increases above 1 with net buys', () => {
    expect(demandMultiplier(500)).toBeGreaterThan(1.0);
  });

  it('decreases below 1 with net sells', () => {
    expect(demandMultiplier(-500)).toBeLessThan(1.0);
  });

  it('clamps at 1.5 for very high demand', () => {
    expect(demandMultiplier(9999999)).toBe(1.5);
  });

  it('clamps at 0.7 for very high supply', () => {
    expect(demandMultiplier(-9999999)).toBe(0.7);
  });
});

describe('livePrice', () => {
  it('returns base price when demand is neutral', () => {
    expect(livePrice(100, 0)).toBeCloseTo(100);
  });

  it('raises price with positive net buys', () => {
    expect(livePrice(100, 1000)).toBeGreaterThan(100);
  });

  it('lowers price with negative net buys', () => {
    expect(livePrice(100, -1000)).toBeLessThan(100);
  });
});

describe('applyMatchToPrice', () => {
  it('raises price for goals + win', () => {
    const newPrice = applyMatchToPrice(100, { goals: 2, assists: 1, minutes: 90, result: 'win' });
    expect(newPrice).toBeGreaterThan(100);
  });

  it('gives a small positive tick for a blank sheet with 60+ min played', () => {
    // perfPoints = 1 (minutes>=60 bonus), resultBonus = 0 (draw), delta = 0.01
    const newPrice = applyMatchToPrice(100, { goals: 0, assists: 0, minutes: 90, result: 'draw' });
    expect(newPrice).toBeCloseTo(101, 0);
  });

  it('lowers price on loss with no contribution', () => {
    const newPrice = applyMatchToPrice(100, { goals: 0, assists: 0, minutes: 90, result: 'loss' });
    expect(newPrice).toBeLessThan(100);
  });

  it('clamps minimum to 5', () => {
    const newPrice = applyMatchToPrice(5, { goals: 0, assists: 0, minutes: 90, result: 'loss' });
    expect(newPrice).toBeGreaterThanOrEqual(5);
  });

  it('clamps maximum to 2000', () => {
    const newPrice = applyMatchToPrice(2000, { goals: 10, assists: 10, minutes: 90, result: 'win' });
    expect(newPrice).toBeLessThanOrEqual(2000);
  });

  it('gives less credit for sub-60 minute appearance', () => {
    const full = applyMatchToPrice(100, { goals: 1, assists: 0, minutes: 90, result: 'draw' });
    const cameo = applyMatchToPrice(100, { goals: 1, assists: 0, minutes: 30, result: 'draw' });
    // cameo misses the +1 minutes bonus; result should be slightly different
    expect(full).not.toBe(cameo);
  });
});

describe('teamPrice', () => {
  it('returns a positive price for a valid roster', () => {
    const roster = Array.from({ length: 11 }, () => ({ price: 100, minutes: 90 }));
    expect(teamPrice(roster, 0)).toBeGreaterThan(0);
  });

  it('adds form bonus for wins', () => {
    const roster = Array.from({ length: 11 }, () => ({ price: 100, minutes: 90 }));
    const noForm = teamPrice(roster, 0);
    const withForm = teamPrice(roster, 18); // 18 pts = 6 wins
    expect(withForm).toBeGreaterThan(noForm);
  });

  it('clamps minimum to 50', () => {
    const roster = [{ price: 0, minutes: 0 }];
    expect(teamPrice(roster, 0)).toBeGreaterThanOrEqual(50);
  });

  it('clamps maximum to 5000', () => {
    const roster = Array.from({ length: 11 }, () => ({ price: 999999, minutes: 90 }));
    expect(teamPrice(roster, 18)).toBeLessThanOrEqual(5000);
  });

  it('returns 50 for an empty roster', () => {
    expect(teamPrice([], 0)).toBe(50);
  });
});
