import { captureException } from "@/lib/observability";
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyCronRequest } from '@/lib/cronAuth';
import { runSettleCron } from '@/lib/cron';
import { FplClient } from '@/lib/fpl';

/**
 * R6.4 — Settle a gameweek when it reports `data_checked: true`.
 * Idempotent on `(player_id, fixture_id)` — Invariant 3.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authErr = verifyCronRequest(req);
  if (authErr) return authErr;

  try {
    const url = new URL(req.url);
    const gwParam = url.searchParams.get('gw');
    const gameweekNumber = gwParam ? Number(gwParam) : undefined;
    const fetchLive = url.searchParams.get('fetchLive') !== 'false';

    const result = await runSettleCron(prisma, {
      gameweekNumber: Number.isInteger(gameweekNumber) ? gameweekNumber : undefined,
      client: fetchLive ? new FplClient() : undefined,
      fetchLive,
    });

    return NextResponse.json({
      ok: true,
      settledCount: result.settled.length,
      settled: result.settled.map((s) => ({
        season: s.season,
        gameweek: s.gameweek,
        seasonStats: s.seasonStats.seasonStats,
        fairValuesWritten: s.fairValues.fairValuesWritten,
        priceTicksWritten: s.fairValues.priceTicksWritten,
        predictions: s.predictions,
      })),
    });
  } catch (error) {
    await captureException(error, { source: "cron:settle" });
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
