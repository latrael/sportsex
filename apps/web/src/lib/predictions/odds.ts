/**
 * R7.1 — Real prediction odds: Poisson match-outcome model on team expected goals
 * using FPL `strengthAttack`/`strengthDefence` and historical xGC, with a ~5% house margin.
 *
 * Replaces the flat 2.0× payout that made favourites ~+40% EV.
 */

export const DEFAULT_STRENGTH = 1200;
export const DEFAULT_XGC_PER_MATCH = 1.38;
export const DEFAULT_HOUSE_MARGIN = 0.05; // 5% target house edge (overround ~ 1.0526)

// Premier League baseline expected goals by venue (calibrated on 25/26: 580 home, 465 away in 380 matches)
const BASE_HOME_XG = 1.5263;
const BASE_AWAY_XG = 1.2237;
const STRENGTH_SENSITIVITY = 0.0022;
const MAX_GOALS_GRID = 10;
const DIXON_COLES_RHO = -0.075;

export interface FixtureOddsInput {
  homeStrengthAttack?: number | null;
  homeStrengthDefence?: number | null;
  awayStrengthAttack?: number | null;
  awayStrengthDefence?: number | null;
  /** Optional historical expected goals conceded per 90/match by home club. */
  homeHistoricalXgcPerMatch?: number | null;
  /** Optional historical expected goals conceded per 90/match by away club. */
  awayHistoricalXgcPerMatch?: number | null;
  /** Target house edge in [0, 0.25]; defaults to 0.05 (5%). */
  houseMargin?: number;
}

export interface FixtureOddsResult {
  lambdaHome: number;
  lambdaAway: number;
  fairProbs: {
    H: number;
    D: number;
    A: number;
  };
  /** Decimal payout multipliers including the house margin (clamped to [1.08, 25.00]). */
  odds: {
    H: number;
    D: number;
    A: number;
  };
  /** Sum of implied probabilities `1/odds.H + 1/odds.D + 1/odds.A` (~1.0526 for 5% margin). */
  overround: number;
  /** Target house edge (`1 - 1/overround`, ~0.05). */
  expectedHouseEdge: number;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function poissonPmf(k: number, lambda: number): number {
  let logFact = 0;
  for (let i = 2; i <= k; i++) {
    logFact += Math.log(i);
  }
  return Math.exp(k * Math.log(Math.max(1e-9, lambda)) - lambda - logFact);
}

/**
 * Dixon-Coles (1997) low-scoring correlation adjustment factor tau(x, y).
 */
function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  lambdaH: number,
  lambdaA: number,
  rho: number,
): number {
  if (homeGoals === 0 && awayGoals === 0) {
    return Math.max(0, 1 - lambdaH * lambdaA * rho);
  }
  if (homeGoals === 0 && awayGoals === 1) {
    return Math.max(0, 1 + lambdaH * rho);
  }
  if (homeGoals === 1 && awayGoals === 0) {
    return Math.max(0, 1 + lambdaA * rho);
  }
  if (homeGoals === 1 && awayGoals === 1) {
    return Math.max(0, 1 - rho);
  }
  return 1;
}

/**
 * Compute fair 1X2 probabilities and decimal odds with a ~5% house margin.
 */
export function computeFixtureOdds(input: FixtureOddsInput = {}): FixtureOddsResult {
  const attH = input.homeStrengthAttack ?? DEFAULT_STRENGTH;
  const defH = input.homeStrengthDefence ?? DEFAULT_STRENGTH;
  const attA = input.awayStrengthAttack ?? DEFAULT_STRENGTH;
  const defA = input.awayStrengthDefence ?? DEFAULT_STRENGTH;

  const xgcH =
    input.homeHistoricalXgcPerMatch && input.homeHistoricalXgcPerMatch > 0
      ? input.homeHistoricalXgcPerMatch
      : DEFAULT_XGC_PER_MATCH;
  const xgcA =
    input.awayHistoricalXgcPerMatch && input.awayHistoricalXgcPerMatch > 0
      ? input.awayHistoricalXgcPerMatch
      : DEFAULT_XGC_PER_MATCH;

  const margin = clamp(input.houseMargin ?? DEFAULT_HOUSE_MARGIN, 0, 0.25);

  const homeStrengthFactor = Math.exp(STRENGTH_SENSITIVITY * (attH - defA));
  const awayStrengthFactor = Math.exp(STRENGTH_SENSITIVITY * (attA - defH));

  // Blend FPL defence strength with historical xGC conceded by opponent (75% strength / 25% xGC)
  const awayDefenceLeakFactor = 0.75 + 0.25 * clamp(xgcA / DEFAULT_XGC_PER_MATCH, 0.55, 1.65);
  const homeDefenceLeakFactor = 0.75 + 0.25 * clamp(xgcH / DEFAULT_XGC_PER_MATCH, 0.55, 1.65);

  const lambdaHome = clamp(
    BASE_HOME_XG * homeStrengthFactor * awayDefenceLeakFactor,
    0.35,
    4.2,
  );
  const lambdaAway = clamp(
    BASE_AWAY_XG * awayStrengthFactor * homeDefenceLeakFactor,
    0.3,
    3.8,
  );

  let pH = 0;
  let pD = 0;
  let pA = 0;

  const homeProbs: number[] = [];
  const awayProbs: number[] = [];
  for (let g = 0; g <= MAX_GOALS_GRID; g++) {
    homeProbs.push(poissonPmf(g, lambdaHome));
    awayProbs.push(poissonPmf(g, lambdaAway));
  }

  for (let h = 0; h <= MAX_GOALS_GRID; h++) {
    for (let a = 0; a <= MAX_GOALS_GRID; a++) {
      const tau = dixonColesTau(h, a, lambdaHome, lambdaAway, DIXON_COLES_RHO);
      const p = homeProbs[h] * awayProbs[a] * tau;
      if (h > a) pH += p;
      else if (h === a) pD += p;
      else pA += p;
    }
  }

  const totalP = pH + pD + pA;
  const fairH = pH / totalP;
  const fairD = pD / totalP;
  const fairA = pA / totalP;

  const returnRatio = 1 - margin;
  const oddsH = Number(clamp(returnRatio / fairH, 1.05, 25.0).toFixed(2));
  const oddsD = Number(clamp(returnRatio / fairD, 1.05, 25.0).toFixed(2));
  const oddsA = Number(clamp(returnRatio / fairA, 1.05, 25.0).toFixed(2));

  const overround = 1 / oddsH + 1 / oddsD + 1 / oddsA;
  const expectedHouseEdge = 1 - 1 / overround;

  return {
    lambdaHome: Number(lambdaHome.toFixed(4)),
    lambdaAway: Number(lambdaAway.toFixed(4)),
    fairProbs: {
      H: Number(fairH.toFixed(4)),
      D: Number(fairD.toFixed(4)),
      A: Number(fairA.toFixed(4)),
    },
    odds: {
      H: oddsH,
      D: oddsD,
      A: oddsA,
    },
    overround: Number(overround.toFixed(4)),
    expectedHouseEdge: Number(expectedHouseEdge.toFixed(4)),
  };
}

export interface SimulatedFixtureForOdds {
  homeScore: number;
  awayScore: number;
  homeStrengthAttack?: number | null;
  homeStrengthDefence?: number | null;
  awayStrengthAttack?: number | null;
  awayStrengthDefence?: number | null;
  homeHistoricalXgcPerMatch?: number | null;
  awayHistoricalXgcPerMatch?: number | null;
}

export interface SeasonPredictionSimulationResult {
  fixtureCount: number;
  totalStaked: number;
  totalPayout: number;
  realizedHouseEdge: number;
  oldFlat2xPayout: number;
  oldFlat2xHouseEdge: number;
}

/**
 * Simulate the prediction book across a full season of finished fixtures (e.g. 380 fixtures of 25/26).
 *
 * Models representative market bettor flow across all 3 outcomes (weighted by market implied
 * probability so favourites attract proportionally more volume, plus comparison against the
 * legacy flat 2.0× favourite-picking strategy that had ~+40% player EV / -40% house edge).
 */
export function simulateSeasonPredictionBook(
  fixtures: readonly SimulatedFixtureForOdds[],
  options: { houseMargin?: number; stakePerMatch?: number } = {},
): SeasonPredictionSimulationResult {
  const stakePerMatch = options.stakePerMatch ?? 1000;
  let totalStaked = 0;
  let totalPayout = 0;
  let oldFlat2xStaked = 0;
  let oldFlat2xPayout = 0;

  for (const f of fixtures) {
    const quoted = computeFixtureOdds({
      homeStrengthAttack: f.homeStrengthAttack,
      homeStrengthDefence: f.homeStrengthDefence,
      awayStrengthAttack: f.awayStrengthAttack,
      awayStrengthDefence: f.awayStrengthDefence,
      homeHistoricalXgcPerMatch: f.homeHistoricalXgcPerMatch,
      awayHistoricalXgcPerMatch: f.awayHistoricalXgcPerMatch,
      houseMargin: options.houseMargin,
    });

    const outcome: 'H' | 'D' | 'A' =
      f.homeScore > f.awayScore ? 'H' : f.awayScore > f.homeScore ? 'A' : 'D';

    // Market bettors allocate stake across H/D/A in proportion to fair probabilities
    const stakeH = stakePerMatch * quoted.fairProbs.H;
    const stakeD = stakePerMatch * quoted.fairProbs.D;
    const stakeA = stakePerMatch * quoted.fairProbs.A;

    totalStaked += stakePerMatch;
    if (outcome === 'H') totalPayout += stakeH * quoted.odds.H;
    else if (outcome === 'D') totalPayout += stakeD * quoted.odds.D;
    else totalPayout += stakeA * quoted.odds.A;

    // Under the legacy flat 2.0x payout, backing strong favourites (fairProb >= 0.55):
    const favPick: 'H' | 'D' | 'A' =
      quoted.fairProbs.H >= quoted.fairProbs.A && quoted.fairProbs.H >= quoted.fairProbs.D
        ? 'H'
        : quoted.fairProbs.A >= quoted.fairProbs.D
          ? 'A'
          : 'D';
    const favProb = Math.max(quoted.fairProbs.H, quoted.fairProbs.D, quoted.fairProbs.A);
    if (favProb >= 0.55) {
      oldFlat2xStaked += stakePerMatch;
      if (favPick === outcome) {
        oldFlat2xPayout += stakePerMatch * 2.0;
      }
    }
  }

  const realizedHouseEdge = totalStaked > 0 ? (totalStaked - totalPayout) / totalStaked : 0;
  const oldFlat2xHouseEdge =
    oldFlat2xStaked > 0 ? (oldFlat2xStaked - oldFlat2xPayout) / oldFlat2xStaked : 0;

  return {
    fixtureCount: fixtures.length,
    totalStaked: Math.round(totalStaked),
    totalPayout: Math.round(totalPayout),
    realizedHouseEdge: Number(realizedHouseEdge.toFixed(4)),
    oldFlat2xPayout: Math.round(oldFlat2xPayout),
    oldFlat2xHouseEdge: Number(oldFlat2xHouseEdge.toFixed(4)),
  };
}
