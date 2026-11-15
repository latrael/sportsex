import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyCronRequest } from '@/lib/cronAuth';
import { runFixturesCron } from '@/lib/cron';

/**
 * R6.2 — Hourly `fixtures` cron.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authErr = verifyCronRequest(req);
  if (authErr) return authErr;

  try {
    const result = await runFixturesCron(prisma);
    return NextResponse.json({
      ok: true,
      season: result.sync.season,
      fixtures: result.sync.fixtures,
      unscheduled: result.sync.unscheduled,
      raw: result.raw,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
