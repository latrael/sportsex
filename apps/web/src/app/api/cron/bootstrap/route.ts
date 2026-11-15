import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyCronRequest } from '@/lib/cronAuth';
import { runBootstrapCron } from '@/lib/cron';

/**
 * R6.1 — Daily `bootstrap-static` cron for prices, availability, and squad changes.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const authErr = verifyCronRequest(req);
  if (authErr) return authErr;

  try {
    const result = await runBootstrapCron(prisma);
    return NextResponse.json({
      ok: true,
      season: result.sync.season,
      clubs: result.sync.clubs,
      clubSeasons: result.sync.clubSeasons,
      players: result.sync.players,
      playerSeasons: result.sync.playerSeasons,
      gameweeks: result.sync.gameweeks,
      raw: result.raw,
      seasonStats: result.seasonStats.seasonStats,
      reprice: result.reprice
        ? {
            assetsCreated: result.reprice.assetsCreated,
            fairValuesWritten: result.reprice.fairValuesWritten,
            priceTicksWritten: result.reprice.priceTicksWritten,
          }
        : null,
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
