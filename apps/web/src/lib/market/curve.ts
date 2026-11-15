/**
 * R4.1 & R4.6 — Exponential Automated Market Maker (AMM) bonding curve.
 *
 * Layer 2 market price formula (REBUILD_PLAN §"Layer 2"):
 *   P(q) = V · exp((q − q₀) / L)
 *
 * Integral cost of moving inventory from `q` to `q + n` (`n > 0` for buy):
 *   cost(q → q + n) = ∫_{q}^{q+n} V · exp((x − q₀) / L) dx
 *                   = V · L · (exp((q + n − q₀) / L) − exp((q − q₀) / L))
 *
 * Integral proceeds of selling `n` shares from `q` to `q − n` (`n > 0` for sell):
 *   proceeds(q → q − n) = ∫_{q−n}^{q} V · exp((x − q₀) / L) dx
 *                       = V · L · (exp((q − q₀) / L) − exp((q − n − q₀) / L))
 *
 * Notice that `proceeds(q + n → q) === cost(q → q + n)` identically!
 * Therefore, in minor units:
 *   - Let `grossMinor = roundHalfUp(integralCoins * MINOR_UNITS_PER_COIN)`
 *     computed over the unordered interval `[min(q_start, q_end), max(q_start, q_end)]`.
 *   - Because the interval `[q, q + n]` on a buy of `n` is identical to the interval
 *     `[q, q + n]` on an immediate sell of `n` from `q + n`, `grossMinor(buy n at q)`
 *     and `grossMinor(sell n at q + n)` are **bit-for-bit identical** (`bigint`).
 *   - Charging `feeMinor` on each side (`roundHalfUp(grossMinor * feeBps / 10000)` with a
 *     1-minor-unit minimum when `feeBps > 0`) means:
 *       - Buyer pays: `netDebit = grossMinor + buyFeeMinor`
 *       - Seller receives: `netCredit = grossMinor - sellFeeMinor`
 *       - Round-trip net change (`buy n` then `sell n`):
 *           `netCredit - netDebit = -(buyFeeMinor + sellFeeMinor)`
 *     **Invariant 1 holds to the exact minor unit for all `n`, all `V`, all starting `q`.**
 */

import { Prisma } from '@prisma/client';
import {
  MINOR_UNITS_PER_COIN,
  minorUnitsToCoinsDecimal,
  toPriceDecimal,
  toLiquidityDecimal,
  type MinorUnits,
} from '@/lib/money';

/** Default trading fee: 50 bps = 0.5% per side. */
export const DEFAULT_FEE_BPS = 50n;

/** Default float size per player/club for scaling liquidity and order limits. */
export const DEFAULT_FLOAT_SHARES = 10_000;

/**
 * R4.6 — Target liquidity depth `L` scaled by float.
 *
 * With `float = 10,000` and `L = 2,000` (`0.20 × float`):
 *   - A 1%-of-float order (`n = 100` shares) moves the spot price by
 *     `exp(100 / 2000) - 1 = exp(0.05) - 1 = +5.127%` (average fill impact ~2.54%),
 *     uniformly within the `[4.5%, 5.5%]` target band across the entire market.
 */
export const LIQUIDITY_TO_FLOAT_RATIO = 0.2;

export function seedLiquidityForFloat(floatShares: number = DEFAULT_FLOAT_SHARES): {
  seedInventory: number;
  liquidity: number;
  liquidityDecimal: Prisma.Decimal;
} {
  if (!Number.isFinite(floatShares) || floatShares <= 0) {
    throw new RangeError(`floatShares must be > 0, got ${floatShares}`);
  }
  const liquidity = Math.max(100, floatShares * LIQUIDITY_TO_FLOAT_RATIO);
  return {
    seedInventory: 0,
    liquidity,
    liquidityDecimal: toLiquidityDecimal(liquidity),
  };
}

export interface CurveState {
  /** Fair value `V` in coins (> 0). */
  fairValue: number | string | Prisma.Decimal;
  /** Current outstanding inventory `q` (shares). */
  inventory: number;
  /** Baseline inventory `q₀` (shares, typically 0). */
  seedInventory?: number;
  /** Liquidity depth `L` (> 0). */
  liquidity: number | string | Prisma.Decimal;
  /** Fee in basis points per side (default 50n = 0.5%). */
  feeBps?: bigint;
}

export interface TradeQuote {
  side: 'BUY' | 'SELL';
  shares: number;
  inventoryBefore: number;
  inventoryAfter: number;
  /** Spot price `P(q_before)` before the trade, in coins. */
  spotPriceBefore: number;
  /** Spot price `P(q_after)` after the trade, in coins. */
  spotPriceAfter: number;
  /** Volume-weighted average execution price (before fee), in coins. */
  avgExecutionPrice: number;
  /** Relative spot price impact `(P_after - P_before) / P_before`. */
  priceImpactPct: number;
  /** Exact curve integral in minor units (`bigint`). */
  grossCostMinor: MinorUnits;
  /** Fee charged on this side in minor units (`bigint`). */
  feeMinor: MinorUnits;
  /**
   * Total cash movement for the user in minor units (`bigint`):
   *   - For BUY: user pays `grossCostMinor + feeMinor` (`userNetCashDeltaMinor = -(grossCostMinor + feeMinor)`)
   *   - For SELL: user receives `grossCostMinor - feeMinor` (`userNetCashDeltaMinor = +(grossCostMinor - feeMinor)`)
   */
  totalUserCashMinor: MinorUnits;
  userNetCashDeltaMinor: MinorUnits;
  /** Ready-to-persist `Prisma.Decimal` values. */
  decimals: {
    spotPriceBefore: Prisma.Decimal;
    spotPriceAfter: Prisma.Decimal;
    avgPrice: Prisma.Decimal;
    fairValue: Prisma.Decimal;
  };
}

function toPosNumber(val: number | string | Prisma.Decimal, name: string): number {
  const n = val instanceof Prisma.Decimal ? val.toNumber() : Number(val);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`${name} must be finite and > 0, got ${val}`);
  }
  return n;
}

/**
 * Compute instantaneous spot price `P(q) = V · exp((q − q₀) / L)`.
 */
export function spotPrice(state: CurveState): number {
  const V = toPosNumber(state.fairValue, 'fairValue');
  const L = toPosNumber(state.liquidity, 'liquidity');
  const q0 = state.seedInventory ?? 0;
  return V * Math.exp((state.inventory - q0) / L);
}

/**
 * Compute exact minor-unit curve integral over the interval `[qLow, qHigh]` where `qLow < qHigh`.
 * Because this depends only on unordered endpoints `qLow` and `qHigh`, buying `n` from `q`
 * (`[q, q+n]`) and selling `n` from `q+n` (`[q, q+n]`) evaluate the exact same expression.
 */
export function curveIntegralMinorUnits(
  V: number,
  L: number,
  q0: number,
  qLow: number,
  qHigh: number,
): MinorUnits {
  if (qHigh === qLow) return 0n;
  const lo = Math.min(qLow, qHigh);
  const hi = Math.max(qLow, qHigh);

  // Use expm1 for numerical accuracy when (hi - lo) / L is small:
  // V * L * (exp((hi - q0)/L) - exp((lo - q0)/L))
  // = V * L * exp((lo - q0)/L) * expm1((hi - lo)/L)
  const baseExp = Math.exp((lo - q0) / L);
  const deltaExp = Math.expm1((hi - lo) / L);
  const integralCoins = V * L * baseExp * deltaExp;

  const scaled = Math.round(integralCoins * Number(MINOR_UNITS_PER_COIN));
  return BigInt(Math.max(1, scaled));
}

/**
 * Compute fee in minor units from `grossCostMinor` and `feeBps` (default 50 bps = 0.5%).
 */
export function computeFeeMinorUnits(
  grossCostMinor: MinorUnits,
  feeBps: bigint = DEFAULT_FEE_BPS,
): MinorUnits {
  if (grossCostMinor <= 0n || feeBps <= 0n) return 0n;
  // Round half-up: (grossCostMinor * feeBps + 5000n) / 10000n, minimum 1 minor unit
  const rounded = (grossCostMinor * feeBps + 5000n) / 10000n;
  return rounded > 0n ? rounded : 1n;
}

/**
 * Quote a BUY or SELL order of `shares` against the AMM bonding curve.
 * Pure, deterministic function used by both `TradeWidget` preview (R5.6)
 * and `POST /api/orders` execution (R4.3) so quoted cost equals filled cost
 * to the last unit.
 */
export function quoteTrade(
  state: CurveState,
  side: 'BUY' | 'SELL' | 'buy' | 'sell',
  shares: number,
): TradeQuote {
  if (!Number.isInteger(shares) || shares <= 0) {
    throw new RangeError(`shares must be a positive integer, got ${shares}`);
  }
  const V = toPosNumber(state.fairValue, 'fairValue');
  const L = toPosNumber(state.liquidity, 'liquidity');
  const q0 = state.seedInventory ?? 0;
  const normSide = side.toUpperCase() as 'BUY' | 'SELL';
  const feeBps = state.feeBps ?? DEFAULT_FEE_BPS;

  const qBefore = state.inventory;
  const qAfter = normSide === 'BUY' ? qBefore + shares : qBefore - shares;

  const pBefore = V * Math.exp((qBefore - q0) / L);
  const pAfter = V * Math.exp((qAfter - q0) / L);

  const grossCostMinor = curveIntegralMinorUnits(V, L, q0, qBefore, qAfter);
  const feeMinor = computeFeeMinorUnits(grossCostMinor, feeBps);

  const totalUserCashMinor =
    normSide === 'BUY' ? grossCostMinor + feeMinor : grossCostMinor - feeMinor;
  const userNetCashDeltaMinor =
    normSide === 'BUY' ? -(grossCostMinor + feeMinor) : grossCostMinor - feeMinor;

  const avgPriceDec = minorUnitsToCoinsDecimal(grossCostMinor)
    .div(new Prisma.Decimal(shares))
    .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

  const impactPct = pBefore > 0 ? (pAfter - pBefore) / pBefore : 0;

  return {
    side: normSide,
    shares,
    inventoryBefore: qBefore,
    inventoryAfter: qAfter,
    spotPriceBefore: pBefore,
    spotPriceAfter: pAfter,
    avgExecutionPrice: avgPriceDec.toNumber(),
    priceImpactPct: impactPct,
    grossCostMinor,
    feeMinor,
    totalUserCashMinor,
    userNetCashDeltaMinor,
    decimals: {
      spotPriceBefore: toPriceDecimal(pBefore),
      spotPriceAfter: toPriceDecimal(pAfter),
      avgPrice: avgPriceDec,
      fairValue: toPriceDecimal(V),
    },
  };
}
