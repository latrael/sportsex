import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FLOAT_SHARES,
  quoteTrade,
  seedLiquidityForFloat,
  spotPrice,
} from '@/lib/market';

describe('R4.1 & R4.6 — AMM Bonding Curve & Invariant 1', () => {
  it('Invariant 1: buy n then immediately sell n loses exactly the fee across all n, all V, all starting q', () => {
    const fairValues = [10, 42.5, 100, 275.1234, 850, 1500];
    const startingInventories = [-500, 0, 100, 1250, 4000];
    const shareSizes = [1, 2, 7, 25, 100, 500, 1000];
    const liquidities = [500, 2000, 5000];

    for (const V of fairValues) {
      for (const q of startingInventories) {
        for (const n of shareSizes) {
          for (const L of liquidities) {
            const buyQuote = quoteTrade(
              { fairValue: V, inventory: q, seedInventory: 0, liquidity: L },
              'BUY',
              n,
            );
            const sellQuote = quoteTrade(
              { fairValue: V, inventory: buyQuote.inventoryAfter, seedInventory: 0, liquidity: L },
              'SELL',
              n,
            );

            // Gross curve integral is bit-for-bit identical on [q, q+n] and [q+n, q]
            expect(buyQuote.grossCostMinor).toBe(sellQuote.grossCostMinor);
            expect(buyQuote.feeMinor).toBe(sellQuote.feeMinor);

            // Net cash change is strictly -(buyFee + sellFee)
            const netMinor = buyQuote.userNetCashDeltaMinor + sellQuote.userNetCashDeltaMinor;
            expect(netMinor).toBe(-(buyQuote.feeMinor + sellQuote.feeMinor));

            // Spot price returns to exact starting spot price
            expect(sellQuote.spotPriceAfter).toBeCloseTo(buyQuote.spotPriceBefore, 10);
          }
        }
      }
    }
  });

  it('R4.3 math check: the §2 exploit sequence (buy 1000 -> buy 1 -> sell 1001) nets a loss equal to fees', () => {
    const V = 100;
    const L = 2000;

    const leg1 = quoteTrade({ fairValue: V, inventory: 0, liquidity: L }, 'BUY', 1000);
    const leg2 = quoteTrade(
      { fairValue: V, inventory: leg1.inventoryAfter, liquidity: L },
      'BUY',
      1,
    );
    const leg3 = quoteTrade(
      { fairValue: V, inventory: leg2.inventoryAfter, liquidity: L },
      'SELL',
      1001,
    );

    const netCashDeltaMinor =
      leg1.userNetCashDeltaMinor + leg2.userNetCashDeltaMinor + leg3.userNetCashDeltaMinor;
    const totalFeesMinor = leg1.feeMinor + leg2.feeMinor + leg3.feeMinor;

    // Because exp((1000)/L) + exp(1/L) equals the integral to 1001 within 1 rounding unit,
    // the trader loses the fees (~3,250 minor units = ~32.50 coins) and can never profit.
    expect(netCashDeltaMinor).toBeLessThan(0n);
    const diffFromFees =
      netCashDeltaMinor + totalFeesMinor < 0n
        ? -(netCashDeltaMinor + totalFeesMinor)
        : netCashDeltaMinor + totalFeesMinor;
    // At most 1 minor unit of sub-cent integral split rounding between (0->1000 + 1000->1001) vs (0->1001)
    expect(diffFromFees).toBeLessThanOrEqual(1n);
  });

  it('R4.6: price impact of a 1%-of-float order sits within the documented [4.5%, 5.5%] target band across the whole market', () => {
    const floats = [2000, 5000, DEFAULT_FLOAT_SHARES, 20000];
    const fairValues = [15, 75, 250, 900, 1450];

    for (const floatShares of floats) {
      const { seedInventory, liquidity } = seedLiquidityForFloat(floatShares);
      const onePctOrder = Math.round(floatShares * 0.01);

      for (const V of fairValues) {
        const q = quoteTrade(
          { fairValue: V, inventory: seedInventory, seedInventory, liquidity },
          'BUY',
          onePctOrder,
        );
        // Spot price impact exp(0.01 / 0.20) - 1 = exp(0.05) - 1 ≈ 5.127%
        expect(q.priceImpactPct).toBeGreaterThanOrEqual(0.045);
        expect(q.priceImpactPct).toBeLessThanOrEqual(0.055);
        expect(spotPrice({ fairValue: V, inventory: seedInventory, seedInventory, liquidity })).toBeCloseTo(V, 8);
      }
    }
  });
});
