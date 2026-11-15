/**
 * R2.4 — Money and price type discipline across the v2 market/valuation layer.
 *
 * Rules (REBUILD_PLAN §"Target architecture", TODO_2627.md R2.4):
 *   1. Coins live in minor units as `bigint` (DB `BigInt`).
 *      1 whole coin = 100 minor units (1 cent-coin), or 1 minor unit = 0.01 coin.
 *      Wait — let's keep the minor-unit scale explicit and configurable via
 *      `MINOR_UNITS_PER_COIN` so every conversion goes through one place.
 *      In sportsex, users see whole coins (e.g. 10,000 starting grant), while
 *      AMM integrals and fees settle in minor units (1 coin = 100 minor units,
 *      or 1:1 minor units if 1 minor unit = 1 coin).
 *      Wait: what scale does the schema expect?
 *      Let's check `schema.prisma`:
 *        - `FairValue.value`: Decimal(12, 4) — "V, in coins. Clamped to [10, 1500]"
 *        - `PriceTick.price`: Decimal(12, 4) — "Market price P after this event, in coins."
 *        - `Trade.avgPrice`: Decimal(12, 4) — "Volume-weighted average fill price, in coins"
 *        - `Trade.grossCost`: BigInt — "Coins moved for the shares, minor units, always >= 0."
 *        - `Trade.fee`: BigInt — "Fee charged this side (~0.5%), minor units."
 *        - `LedgerEntry.amount`: BigInt — "Signed minor units: credit > 0, debit < 0."
 *      Using `MINOR_UNITS_PER_COIN = 100n` (cents of a coin, 2 decimal places)
 *      means a 0.5% fee on a 10-coin trade is 5 minor units (0.05 coins) rather
 *      than rounding to 0, while 10,000 coins = 1,000,000n minor units.
 *   2. Prices and fair values are `Prisma.Decimal` at the DB boundary — never
 *      JS `number` floats passed directly into Prisma writes.
 */

import { Prisma } from '@prisma/client';

/**
 * 1 coin = 100 minor units (2 decimal places).
 * Keeps 0.5% fees and fractional share costs exact on single-share trades
 * while storing all cash movements as exact `bigint` integers.
 */
export const MINOR_UNITS_PER_COIN = 100n;
export const MINOR_UNITS_PER_COIN_DECIMAL = new Prisma.Decimal(100);

/** Branded/typed alias for coin amounts in minor units (`bigint`). */
export type MinorUnits = bigint;

/** Convert whole coins (integer or string/Decimal) to minor units (`bigint`). */
export function coinsToMinorUnits(coins: number | bigint | string | Prisma.Decimal): MinorUnits {
  if (typeof coins === 'bigint') {
    return coins * MINOR_UNITS_PER_COIN;
  }
  const d = coins instanceof Prisma.Decimal ? coins : new Prisma.Decimal(String(coins));
  const scaled = d.mul(MINOR_UNITS_PER_COIN_DECIMAL).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return BigInt(scaled.toFixed(0));
}

/** Convert minor units (`bigint`) to a `Prisma.Decimal` in whole coins (exact, 2 dp). */
export function minorUnitsToCoinsDecimal(minor: MinorUnits): Prisma.Decimal {
  return new Prisma.Decimal(minor.toString()).div(MINOR_UNITS_PER_COIN_DECIMAL);
}

/**
 * Format minor units as a display number of coins (2 decimal places) for UI rendering only.
 * Never feed this back into a DB write or ledger calculation.
 */
export function formatMinorUnitsAsCoins(minor: MinorUnits): string {
  return minorUnitsToCoinsDecimal(minor).toFixed(2);
}

/**
 * Construct a `Prisma.Decimal` rounded to the schema's price precision `Decimal(12, 4)`.
 * Accepts string or `Prisma.Decimal` (or finite number from pure math engines like `Math.exp`
 * inside valuation/AMM before crossing the DB boundary).
 */
export function toPriceDecimal(value: Prisma.Decimal | string | number): Prisma.Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`toPriceDecimal: non-finite number ${value}`);
  }
  const d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value));
  return d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Construct a `Prisma.Decimal` rounded to the schema's audit-component precision `Decimal(12, 6)`.
 */
export function toAuditDecimal(value: Prisma.Decimal | string | number): Prisma.Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`toAuditDecimal: non-finite number ${value}`);
  }
  const d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value));
  return d.toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Construct a `Prisma.Decimal` rounded to the schema's availability multiplier precision `Decimal(6, 4)`.
 */
export function toMultiplierDecimal(value: Prisma.Decimal | string | number): Prisma.Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`toMultiplierDecimal: non-finite number ${value}`);
  }
  const d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value));
  return d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Construct a `Prisma.Decimal` rounded to the schema's liquidity precision `Decimal(18, 6)`.
 */
export function toLiquidityDecimal(value: Prisma.Decimal | string | number): Prisma.Decimal {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`toLiquidityDecimal: non-finite number ${value}`);
  }
  const d = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(String(value));
  return d.toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Convert a `Prisma.Decimal` cost in coins into `bigint` minor units using the
 * caller-specified rounding mode:
 *   - BUY grossCost rounds CEIL (buyer never underpays the curve)
 *   - SELL grossProceeds rounds FLOOR (AMM never overpays the curve)
 *   - FEE rounds CEIL with a 1-minor-unit floor when the trade is non-zero
 */
export function decimalCoinsToMinorUnits(
  coins: Prisma.Decimal,
  rounding: 'ceil' | 'floor' | 'half_up',
): MinorUnits {
  const mode =
    rounding === 'ceil'
      ? Prisma.Decimal.ROUND_CEIL
      : rounding === 'floor'
        ? Prisma.Decimal.ROUND_FLOOR
        : Prisma.Decimal.ROUND_HALF_UP;
  const scaled = coins.mul(MINOR_UNITS_PER_COIN_DECIMAL).toDecimalPlaces(0, mode);
  return BigInt(scaled.toFixed(0));
}
