import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyCronRequest } from '@/lib/cronAuth';
import { runDailyReconciliation } from '@/lib/reconcile';
import { captureException } from '@/lib/observability';

/**
 * R7.5 — Daily reconciliation cron asserting Invariants 2 and 4 in production.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authErr = verifyCronRequest(req);
  if (authErr) return authErr;

  try {
    const result = await runDailyReconciliation(prisma);
    return NextResponse.json(
      {
        ok: result.ok,
        invariant2: {
          ok: result.invariant2.ok,
          globalSumMinor: result.invariant2.globalSumMinor.toString(),
          unbalancedTransferCount: result.invariant2.unbalancedTransfers.length,
          negativeUserCount: result.invariant2.negativeUserBalances.length,
        },
        invariant4: {
          ok: result.invariant4.ok,
          seasonsChecked: result.invariant4.seasonsChecked,
          driftedBySeason: result.invariant4.driftedBySeason,
        },
        alertsFiredCount: result.alertsFired.length,
      },
      { status: result.ok ? 200 : 500 },
    );
  } catch (error) {
    await captureException(error, { source: 'cron:reconcile' });
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
