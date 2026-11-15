/**
 * Browser-safe pure AMM bonding curve math (`bigint` minor units).
 *
 * Shared between `src/lib/market/curve.ts` (server execution) and
 * `src/components/TradeWidget.tsx` (client preview, R5.6) so the quoted
 * gross cost, fee, total cash movement, and price impact match the filled
 * order to the last minor unit.
 */

export const MINOR_UNITS_SCALE = 100n;
export const DEFAULT_FEE_BPS = 50n;
export const DEFAULT_FLOAT_SHARES = 10_000;
export const LIQUIDITY_TO_FLOAT_RATIO = 0.2;

export interface PureCurveState {
  fairValue: number;
  inventory: number;
  seedInventory?: number;
  liquidity: number;
  feeBps?: bigint;
}

export interface PureTradeQuote {
  side: 'BUY' | 'SELL';
  shares: number;
  inventoryBefore: number;
  inventoryAfter: number;
  spotPriceBefore: number;
  spotPriceAfter: number;
  avgExecutionPrice: number;
  priceImpactPct: number;
  grossCostMinor: bigint;
  feeMinor: bigint;
  totalUserCashMinor: bigint;
  userNetCashDeltaMinor: bigint;
  grossCostCoins: number;
  feeCoins: number;
  totalUserCashCoins: number;
}

export function curveIntegralMinorUnits(
  V: number,
  L: number,
  q0: number,
  qLow: number,
  qHigh: number,
): bigint {
  if (qHigh === qLow) return 0n;
  const lo = Math.min(qLow, qHigh);
  const hi = Math.max(qLow, qHigh);

  const baseExp = Math.exp((lo - q0) / L);
  const deltaExp = Math.expm1((hi - lo) / L);
  const integralCoins = V * L * baseExp * deltaExp;

  const scaled = Math.round(integralCoins * Number(MINOR_UNITS_SCALE));
  return BigInt(Math.max(1, scaled));
}

export function computeFeeMinorUnits(
  grossCostMinor: bigint,
  feeBps: bigint = DEFAULT_FEE_BPS,
): bigint {
  if (grossCostMinor <= 0n || feeBps <= 0n) return 0n;
  const rounded = (grossCostMinor * feeBps + 5000n) / 10000n;
  return rounded > 0n ? rounded : 1n;
}

export function quoteTradePure(
  state: PureCurveState,
  side: 'BUY' | 'SELL' | 'buy' | 'sell',
  shares: number,
): PureTradeQuote {
  if (!Number.isInteger(shares) || shares <= 0) {
    throw new RangeError(`shares must be a positive integer, got ${shares}`);
  }
  const V = state.fairValue;
  const L = state.liquidity;
  if (!Number.isFinite(V) || V <= 0) {
    throw new RangeError(`fairValue must be finite and > 0, got ${V}`);
  }
  if (!Number.isFinite(L) || L <= 0) {
    throw new RangeError(`liquidity must be finite and > 0, got ${L}`);
  }

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

  const grossCostCoins = Number(grossCostMinor) / 100;
  const feeCoins = Number(feeMinor) / 100;
  const totalUserCashCoins = Number(totalUserCashMinor) / 100;
  const avgExecutionPrice = Math.round((grossCostCoins / shares) * 10000) / 10000;
  const impactPct = pBefore > 0 ? (pAfter - pBefore) / pBefore : 0;

  return {
    side: normSide,
    shares,
    inventoryBefore: qBefore,
    inventoryAfter: qAfter,
    spotPriceBefore: pBefore,
    spotPriceAfter: pAfter,
    avgExecutionPrice,
    priceImpactPct: impactPct,
    grossCostMinor,
    feeMinor,
    totalUserCashMinor,
    userNetCashDeltaMinor,
    grossCostCoins,
    feeCoins,
    totalUserCashCoins,
  };
}
