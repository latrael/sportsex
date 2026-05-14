// sportsex pricing — v1 rudimentary algorithm.
// Designed to be swapped wholesale later. Keep function signatures stable.
// See AGENTS.md §4 for spec.

export const PRICE_FLOOR = 5;
export const PRICE_CAP = 2000;
export const TEAM_PRICE_FLOOR = 50;
export const TEAM_PRICE_CAP = 5000;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export type SeedInput = {
  goals: number;
  assists: number;
  minutes: number;
};

export function seedPrice(p: SeedInput): number {
  const productivity = p.goals * 5 + p.assists * 3;
  const minutesFactor = Math.min(p.minutes / 1000, 3) * 10;
  return clamp(50 + productivity + minutesFactor, PRICE_FLOOR, PRICE_CAP);
}

export function demandMultiplier(netBuys24h: number): number {
  return clamp(1 + 0.0005 * netBuys24h, 0.7, 1.5);
}

export function livePrice(basePrice: number, netBuys24h: number): number {
  return clamp(basePrice * demandMultiplier(netBuys24h), PRICE_FLOOR, PRICE_CAP);
}

export type MatchPerf = {
  goals: number;
  assists: number;
  minutes: number;
  result: 'win' | 'draw' | 'loss';
};

export function matchSettleDelta(perf: MatchPerf): number {
  const perfPoints =
    perf.goals * 8 + perf.assists * 5 + (perf.minutes >= 60 ? 1 : 0);
  const resultBonus = perf.result === 'win' ? 2 : perf.result === 'draw' ? 0 : -2;
  return (perfPoints + resultBonus) / 100;
}

export function applyMatchToPrice(lastPrice: number, perf: MatchPerf): number {
  return clamp(lastPrice * (1 + matchSettleDelta(perf)), PRICE_FLOOR, PRICE_CAP);
}

export type RosterPlayerForTeam = { price: number; minutes: number };

export function teamPrice(roster: RosterPlayerForTeam[], teamPoints6Match = 0): number {
  if (roster.length === 0) return TEAM_PRICE_FLOOR;
  const top11 = [...roster].sort((a, b) => b.minutes - a.minutes).slice(0, 11);
  const rosterAvg = top11.reduce((s, p) => s + p.price, 0) / top11.length;
  const formBonus = teamPoints6Match * 2;
  return clamp(rosterAvg + formBonus, TEAM_PRICE_FLOOR, TEAM_PRICE_CAP);
}
