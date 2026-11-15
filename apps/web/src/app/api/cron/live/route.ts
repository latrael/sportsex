import { captureException } from "@/lib/observability";
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyCronRequest } from '@/lib/cronAuth';
import { runLiveCron } from '@/lib/cron';

/**
 * R6.3 — Live poll of `event/{gw}/live` every 2 minutes inside match windows only.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authErr = verifyCronRequest(req);
  if (authErr) return authErr;

  try {
    const result = await runLiveCron(prisma);
    return NextResponse.json({
      ok: true,
      skipped: result.skipped,
      reason: result.reason ?? null,
      startYear: result.startYear,
      gameweeksPolled: result.gameweeksPolled,
      results: result.results,
    });
  } catch (error) {
    await captureException(error, { source: "cron:live" });
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
