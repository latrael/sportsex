# Season Rollover Runbook (2025/26 → 2026/27)

Companion to [`REBUILD_PLAN_2627.md`](REBUILD_PLAN_2627.md) and [`TODO_2627.md`](TODO_2627.md) (`R6.6` & `R7.6`).

## 1. Overview & Architecture

Every July/August before Gameweek 1, Fantasy Premier League (FPL) wipes its live API endpoints (`bootstrap-static`, `fixtures`, `event/{gw}/live`) and rebuilds them for the new season:
- Every `element.id` (`1..N`) and `team.id` (`1..20`) is **renumbered**.
- Preseason `team.strength` and `strength_overall/attack/defence_*` fields are served as **`null`** until closer to GW1 (handled by `R1.1` migration `20260723191314_r1_1_nullable_club_strength`).
- Cross-season identity is anchored on `player.fplCode` (`element.code`) and `club.fplCode` (`team.code`).
- Season membership (`player_season`, `club_season`, `gameweek`, `fixture`) and market instruments (`asset`) are scoped by `seasonId`, so ingesting 2026/27 **never overwrites or corrupts 2025/26 history**.

---

## 2. Open-Position Policy at Rollover (`R7.6`)

The canonical rollover policy implemented in [`apps/web/src/lib/rollover/seasonRollover.ts`](apps/web/src/lib/rollover/seasonRollover.ts) is **`CARRY_WITH_CASH_OUT_DEPARTED`**:
1. **Continuing players & clubs (`CARRY`)**: Any open `Position` (`shares > 0`) whose underlying `Player` (`playerId`) or `Club` (`clubId`) is present in the new 2026/27 season carries its exact `shares` into the new season's `Asset`, with `avgCost` reset to the new season's GW1 `SEED` fair value and `inventory` transferred to the new asset.
2. **Departed players & relegated clubs (`CASH_OUT_DEPARTED`)**: Any open `Position` whose player transferred out of the Premier League or whose club was relegated is automatically cashed out at its final 2025/26 price (`shares × finalPrice`) with **zero fee**, via a balanced double-entry transfer (`AMM_LIQUIDITY` → `USER_CASH`).
3. An alternative policy (`CASH_OUT_ALL`) is also supported by `rolloverSeason` if a full cash reset is ever desired in a future season.

---

## 3. Pre-Cutover Checklist (1 Week Before GW1)

1. **Verify 2025/26 Final Settlement & Reconciliation**:
   - Confirm GW38 of 2025/26 has `settledAt != null`.
   - Run `reconcileLedger(prisma)` and `recomputeSeasonStats(prisma, { startYear: 2025, check: true })` and verify zero drift.
2. **Take a Database Snapshot / Neon Branch**:
   - Create a point-in-time branch in Neon (`pre-rollover-2026`) before running the rollover.
3. **Verify FPL API Has Rolled Over**:
   - Check `bootstrap-static` `events[0].deadline_time` starts in `2026-08-*` (`deriveSeason` resolves `startYear: 2026`, `name: "2026-27"`).

---

## 4. Cutover Execution

Run `rolloverSeason` against staging first, then production:

```ts
import { prisma } from '@/lib/db';
import { FplClient } from '@/lib/fpl';
import { rolloverSeason } from '@/lib/rollover/seasonRollover';

const client = new FplClient();
const [{ data: bootstrapPayload }, { data: fixturesPayload }] = await Promise.all([
  client.bootstrapStatic(),
  client.fixtures(),
]);

const result = await rolloverSeason(prisma, {
  fromStartYear: 2025,
  bootstrapPayload,
  fixturesPayload,
  positionPolicy: 'CARRY_WITH_CASH_OUT_DEPARTED',
});
console.log(result);
```

### Verification Gates (Automated by `rolloverSeason`)
- `result.verification.previousSeasonFixturesIntact === true` (all 380 fixtures from 2025/26 untouched).
- `result.verification.previousSeasonFairValuesIntact === true` (all 32,718 fair values from 2025/26 untouched).
- `result.verification.ledgerReconciled === true` (Invariant 2 holds: `globalSumMinor === 0n`, zero unbalanced transfers, zero negative balances).
- `Season(startYear: 2026)` has 20 `club_season` rows, 38 `gameweek` rows, 380 `fixture` rows, and initial `SEED` `fair_value` + `VALUATION` `price_tick` rows for every 2026/27 player and club.

---

## 5. Rollback Procedure

If an issue is discovered during staging rehearsal or before live 2026/27 trading opens:

1. **Automated In-Database Rollback (Pre-Trading)**:
   Call `rollbackSeasonRollover(prisma, { targetStartYear: 2026 })` from [`apps/web/src/lib/rollover/seasonRollover.ts`](apps/web/src/lib/rollover/seasonRollover.ts). This removes all 2026/27 season-scoped derived, market, event, and reference rows inside a single Postgres transaction while leaving 2025/26 completely intact.
2. **Full Point-in-Time Restore (If Open Positions Were Migrated)**:
   Restore from the `pre-rollover-2026` Neon branch created in Step 3.2.
