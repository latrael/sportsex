/**
 * R7.3 — 30-day economy simulation with AMM trading fees (50 bps per side) as
 * the primary coin sink, balanced against daily quest mints and the 5% prediction
 * house edge.
 */

import { quoteTrade } from '@/lib/market/curve';
import { computeFixtureOdds } from '@/lib/predictions/odds';
import { MINOR_UNITS_PER_COIN, coinsToMinorUnits } from '@/lib/money';

export interface EconomySimulationOptions {
  days?: number;
  userCount?: number;
  initialCoinsPerUser?: number;
  /** Daily active quest claim rate across users (0..1). Default 0.60. */
  dailyQuestParticipationRate?: number;
  /** Average daily quest coins claimed per participating user (capped at 450). Default 250. */
  avgQuestCoinsPerActiveUser?: number;
  /** Average number of AMM trades per user per day. Default 6. */
  tradesPerUserPerDay?: number;
  /** Shares per trade on an average V=280 coin asset. Default 12. */
  sharesPerTrade?: number;
  /** Average daily prediction stake per user across matchdays. Default 200. */
  predictionStakePerUserPerDay?: number;
}

export interface EconomySimulationResult {
  days: number;
  userCount: number;
  initialSupplyMinor: bigint;
  totalQuestMintsMinor: bigint;
  totalTradingFeesBurnedMinor: bigint;
  totalPredictionNetSinkMinor: bigint;
  totalSinksMinor: bigint;
  endingSupplyMinor: bigint;
  netSupplyDeltaMinor: bigint;
  /** Net 30-day supply change as a percentage of initial supply (negative = mildly deflationary). */
  netInflationPct: number;
  /** Share of total sinks coming from AMM trading fees (primary sink > 0.70). */
  tradingFeeSinkShare: number;
}

/**
 * Deterministically simulate a 30-day economy across `userCount` users.
 */
export function simulate30DayEconomy(
  options: EconomySimulationOptions = {},
): EconomySimulationResult {
  const days = options.days ?? 30;
  const userCount = options.userCount ?? 100;
  const initialCoinsPerUser = options.initialCoinsPerUser ?? 10_000;
  const questParticipation = options.dailyQuestParticipationRate ?? 0.6;
  const avgQuestCoins = Math.min(450, options.avgQuestCoinsPerActiveUser ?? 240);
  const tradesPerUserPerDay = options.tradesPerUserPerDay ?? 8;
  const sharesPerTrade = options.sharesPerTrade ?? 12;
  const predictionStakePerUserPerDay = options.predictionStakePerUserPerDay ?? 200;

  const initialSupplyMinor =
    coinsToMinorUnits(initialCoinsPerUser) * BigInt(userCount);

  let totalQuestMintsMinor = 0n;
  let totalTradingFeesBurnedMinor = 0n;
  let totalPredictionNetSinkMinor = 0n;

  // Representative asset pool for AMM trades
  const assetFairValues = [180, 240, 280, 340, 420];
  const assetInventories = [0, 0, 0, 0, 0];
  const liquidity = 2000;

  // Representative fixture odds (5% house margin)
  const sampleOdds = computeFixtureOdds({
    homeStrengthAttack: 1250,
    homeStrengthDefence: 1220,
    awayStrengthAttack: 1180,
    awayStrengthDefence: 1190,
    houseMargin: 0.05,
  });

  for (let day = 0; day < days; day++) {
    // 1. Daily quest mints (faucet)
    const activeQuestUsers = Math.round(userCount * questParticipation);
    const dailyQuestMintMinor =
      coinsToMinorUnits(avgQuestCoins) * BigInt(activeQuestUsers);
    totalQuestMintsMinor += dailyQuestMintMinor;

    // 2. AMM trading volume & 50 bps fee burn (primary sink)
    const totalTradesToday = userCount * tradesPerUserPerDay;
    for (let t = 0; t < totalTradesToday; t++) {
      const assetIdx = (day + t) % assetFairValues.length;
      const currentInv = assetInventories[assetIdx];
      // Alternate BUY and SELL when inventory allows so inventory oscillates realistically
      const side: 'BUY' | 'SELL' =
        t % 2 === 0 || currentInv < sharesPerTrade ? 'BUY' : 'SELL';

      const quote = quoteTrade(
        {
          fairValue: assetFairValues[assetIdx],
          inventory: currentInv,
          seedInventory: 0,
          liquidity,
        },
        side,
        sharesPerTrade,
      );

      assetInventories[assetIdx] = quote.inventoryAfter;
      totalTradingFeesBurnedMinor += quote.feeMinor;
    }

    // 3. Matchday predictions with 5% house edge (secondary sink)
    const dailyStakedCoins = userCount * predictionStakePerUserPerDay;
    const dailyExpectedReturnCoins = Math.round(
      dailyStakedCoins * (1 - sampleOdds.expectedHouseEdge),
    );
    const dailyPredictionSinkMinor = coinsToMinorUnits(
      dailyStakedCoins - dailyExpectedReturnCoins,
    );
    totalPredictionNetSinkMinor += dailyPredictionSinkMinor;
  }

  const totalSinksMinor =
    totalTradingFeesBurnedMinor + totalPredictionNetSinkMinor;
  const netSupplyDeltaMinor = totalQuestMintsMinor - totalSinksMinor;
  const endingSupplyMinor = initialSupplyMinor + netSupplyDeltaMinor;

  const netInflationPct =
    Number(netSupplyDeltaMinor) / Number(initialSupplyMinor) * 100;
  const tradingFeeSinkShare =
    totalSinksMinor > 0n
      ? Number(totalTradingFeesBurnedMinor) / Number(totalSinksMinor)
      : 0;

  return {
    days,
    userCount,
    initialSupplyMinor,
    totalQuestMintsMinor,
    totalTradingFeesBurnedMinor,
    totalPredictionNetSinkMinor,
    totalSinksMinor,
    endingSupplyMinor,
    netSupplyDeltaMinor,
    netInflationPct: Number(netInflationPct.toFixed(4)),
    tradingFeeSinkShare: Number(tradingFeeSinkShare.toFixed(4)),
  };
}
