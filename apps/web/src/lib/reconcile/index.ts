import type { PrismaClient } from '@prisma/client';
import { reconcileLedger, type LedgerReconciliationReport } from '@/lib/market/ledger';
import { recomputeSeasonStats, type SeasonStatsSyncResult } from '@/lib/derive/seasonStats/sync';
import { captureAlert, type CapturedAlertEvent } from '@/lib/observability';

export interface DailyReconciliationResult {
  ok: boolean;
  invariant2: LedgerReconciliationReport;
  invariant4: {
    ok: boolean;
    seasonsChecked: number[];
    driftedBySeason: Record<number, number[]>;
    results: SeasonStatsSyncResult[];
  };
  alertsFired: CapturedAlertEvent[];
}

/**
 * R7.5 — Daily production reconciliation job asserting:
 * - Invariant 2: Total coins in circulation changes only via explicit mints and fee burns,
 *   every transfer sums to 0n, and no user has a negative balance (`reconcileLedger`).
 * - Invariant 4: Recomputing `player_season_stat` from the immutable event rows reproduces
 *   the stored aggregates exactly (`recomputeSeasonStats` in `check: true` mode).
 *
 * Fires `captureAlert` whenever either invariant fails.
 */
export async function runDailyReconciliation(
  db: PrismaClient,
  options: {
    startYear?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DailyReconciliationResult> {
  const alertsFired: CapturedAlertEvent[] = [];

  // 1. Invariant 2 — Ledger conservation & non-negative balances
  const invariant2 = await reconcileLedger(db);
  if (!invariant2.ok) {
    const alert = await captureAlert({
      source: 'reconcile:invariant2',
      title: 'Invariant 2 failed: ledger drift or negative balance detected',
      severity: 'critical',
      details: {
        globalSumMinor: invariant2.globalSumMinor.toString(),
        unbalancedTransfers: invariant2.unbalancedTransfers.map((u) => ({
          transferId: u.transferId,
          sumMinor: u.sumMinor.toString(),
        })),
        negativeUserBalances: invariant2.negativeUserBalances.map((u) => ({
          userId: u.userId,
          balanceMinor: u.balanceMinor.toString(),
        })),
      },
      fetchImpl: options.fetchImpl,
    });
    alertsFired.push(alert);
  }

  // 2. Invariant 4 — Season aggregates match immutable event tables
  const seasons =
    options.startYear !== undefined
      ? await db.season.findMany({ where: { startYear: options.startYear } })
      : await db.season.findMany({ orderBy: { startYear: 'asc' } });

  const seasonsChecked: number[] = [];
  const driftedBySeason: Record<number, number[]> = {};
  const results: SeasonStatsSyncResult[] = [];
  let invariant4Ok = true;

  for (const s of seasons) {
    seasonsChecked.push(s.startYear);
    const res = await recomputeSeasonStats(db, {
      startYear: s.startYear,
      check: true,
    });
    results.push(res);
    if (res.drifted.length > 0) {
      invariant4Ok = false;
      driftedBySeason[s.startYear] = res.drifted;
      const alert = await captureAlert({
        source: 'reconcile:invariant4',
        title: `Invariant 4 failed: ${res.drifted.length} player_season_stat row(s) drifted in season ${s.startYear}`,
        severity: 'critical',
        details: {
          startYear: s.startYear,
          driftedCount: res.drifted.length,
          driftedPlayerSeasonIds: res.drifted.slice(0, 50),
        },
        fetchImpl: options.fetchImpl,
      });
      alertsFired.push(alert);
    }
  }

  return {
    ok: invariant2.ok && invariant4Ok,
    invariant2,
    invariant4: {
      ok: invariant4Ok,
      seasonsChecked,
      driftedBySeason,
      results,
    },
    alertsFired,
  };
}
