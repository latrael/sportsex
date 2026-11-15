/**
 * Sync Layer 1 fair values (`fair_value` table) and initial/re-valued `asset`
 * + `price_tick` rows for a season or specific gameweek.
 *
 * Idempotent: re-running for the same `(assetId, gameweekId, source)` updates
 * only changed rows and never duplicates ticks.
 */

import {
  AssetKind,
  FairValueSource,
  PriceTickSource,
  type PrismaClient,
} from '@prisma/client';
import { toPriceDecimal, toLiquidityDecimal } from '@/lib/money';
import {
  evaluateLeagueAtGameweek,
  clubFairValue,
  type EvaluatedPlayerValuation,
  type PerformanceStatInput,
  type PlayerValuationMetadata,
} from './index';

export interface SyncFairValuesOptions {
  startYear: number;
  /** Gameweek number (1..38) to compute and persist; if omitted, syncs all finished gameweeks 1..maxGw. */
  gameweekNumber?: number;
  source?: FairValueSource;
  /** Default liquidity depth `L` for newly created assets (R4.6 refines this by float). */
  defaultPlayerLiquidity?: number;
  defaultClubLiquidity?: number;
}

export interface SyncFairValuesResult {
  assetsCreated: number;
  fairValuesWritten: number;
  priceTicksWritten: number;
  playerValuations: EvaluatedPlayerValuation[];
}

/**
 * Compute and persist `Asset`, `FairValue`, and `PriceTick` rows for a season.
 */
export async function syncSeasonFairValues(
  db: PrismaClient,
  opts: SyncFairValuesOptions,
): Promise<SyncFairValuesResult> {
  const season = await db.season.findUnique({ where: { startYear: opts.startYear } });
  if (!season) {
    throw new Error(`Season with startYear=${opts.startYear} not found`);
  }

  const playerSeasons = await db.playerSeason.findMany({
    where: { seasonId: season.id },
    include: {
      player: true,
      clubSeason: { include: { club: true } },
      asset: true,
    },
    orderBy: { id: 'asc' },
  });

  const clubSeasons = await db.clubSeason.findMany({
    where: { seasonId: season.id },
    include: { club: true, asset: true },
    orderBy: { id: 'asc' },
  });

  const gameweeks = await db.gameweek.findMany({
    where: { seasonId: season.id },
    orderBy: { number: 'asc' },
  });

  const gwByNumber = new Map(gameweeks.map((g) => [g.number, g]));

  // Ensure every playerSeason and clubSeason has an Asset row
  let assetsCreated = 0;
  const playerAssetByPsId = new Map<number, { id: number; inventory: number; seedInventory: number; liquidity: number }>();
  for (const ps of playerSeasons) {
    if (ps.asset) {
      playerAssetByPsId.set(ps.id, {
        id: ps.asset.id,
        inventory: ps.asset.inventory,
        seedInventory: ps.asset.seedInventory,
        liquidity: Number(ps.asset.liquidity),
      });
    } else {
      // Scale default liquidity L by FPL nowCost tier (R4.6)
      const liq = opts.defaultPlayerLiquidity ?? Math.max(200, ps.nowCost * 10);
      const created = await db.asset.create({
        data: {
          kind: AssetKind.PLAYER,
          playerSeasonId: ps.id,
          inventory: 0,
          seedInventory: 0,
          liquidity: toLiquidityDecimal(liq),
        },
      });
      assetsCreated += 1;
      playerAssetByPsId.set(ps.id, {
        id: created.id,
        inventory: created.inventory,
        seedInventory: created.seedInventory,
        liquidity: liq,
      });
    }
  }

  const clubAssetByCsId = new Map<number, { id: number; inventory: number; seedInventory: number; liquidity: number }>();
  for (const cs of clubSeasons) {
    if (cs.asset) {
      clubAssetByCsId.set(cs.id, {
        id: cs.asset.id,
        inventory: cs.asset.inventory,
        seedInventory: cs.asset.seedInventory,
        liquidity: Number(cs.asset.liquidity),
      });
    } else {
      const liq = opts.defaultClubLiquidity ?? 1000;
      const created = await db.asset.create({
        data: {
          kind: AssetKind.CLUB,
          clubSeasonId: cs.id,
          inventory: 0,
          seedInventory: 0,
          liquidity: toLiquidityDecimal(liq),
        },
      });
      assetsCreated += 1;
      clubAssetByCsId.set(cs.id, {
        id: created.id,
        inventory: created.inventory,
        seedInventory: created.seedInventory,
        liquidity: liq,
      });
    }
  }

  // Load gameweek stats and finished fixtures
  const gwStatRows = await db.playerGameweekStat.findMany({
    where: { gameweek: { seasonId: season.id } },
    include: {
      gameweek: { select: { number: true } },
      playerSeason: { select: { position: true } },
    },
    orderBy: [{ gameweek: { number: 'asc' } }, { playerSeasonId: 'asc' }],
  });

  const fixtures = await db.fixture.findMany({
    where: { seasonId: season.id, finished: true },
    include: { gameweek: { select: { number: true } } },
    orderBy: { id: 'asc' },
  });

  const playersMeta: PlayerValuationMetadata[] = playerSeasons.map((ps) => ({
    playerSeasonId: ps.id,
    fplId: ps.fplId,
    webName: ps.player.webName,
    firstName: ps.player.firstName,
    secondName: ps.player.secondName,
    clubSeasonId: ps.clubSeasonId,
    clubShortName: ps.clubSeason.club.shortName,
    position: ps.position,
    status: ps.status,
    chanceOfPlayingNextRound: ps.chanceOfPlayingNextRound,
    nowCost: ps.nowCost,
  }));

  const stats: (PerformanceStatInput & { starts: number })[] = gwStatRows.map((r) => ({
    playerSeasonId: r.playerSeasonId,
    gameweekNumber: r.gameweek.number,
    position: r.playerSeason.position,
    minutes: r.minutes,
    starts: r.starts,
    goalsScored: r.goalsScored,
    assists: r.assists,
    cleanSheets: r.cleanSheets,
    goalsConceded: r.goalsConceded,
    ownGoals: r.ownGoals,
    penaltiesSaved: r.penaltiesSaved,
    penaltiesMissed: r.penaltiesMissed,
    yellowCards: r.yellowCards,
    redCards: r.redCards,
    saves: r.saves,
    bonus: r.bonus,
    tackles: r.tackles,
    recoveries: r.recoveries,
    clearancesBlocksInterceptions: r.clearancesBlocksInterceptions,
    defensiveContribution: r.defensiveContribution,
    expectedGoals: r.expectedGoals.toString(),
    expectedAssists: r.expectedAssists.toString(),
    expectedGoalsConceded: r.expectedGoalsConceded.toString(),
    threat: r.threat.toString(),
    creativity: r.creativity.toString(),
  }));

  const targetGws =
    opts.gameweekNumber !== undefined
      ? [opts.gameweekNumber]
      : gameweeks.filter((g) => g.finished || g.dataChecked).map((g) => g.number);

  let fairValuesWritten = 0;
  let priceTicksWritten = 0;
  let lastEvaluations: EvaluatedPlayerValuation[] = [];

  const maxTargetGw = targetGws.length > 0 ? Math.max(...targetGws) : 1;

  for (const gwNum of targetGws) {
    const gwRecord = gwByNumber.get(gwNum);
    if (!gwRecord) continue;

    const evaluations = evaluateLeagueAtGameweek({
      players: playersMeta,
      gameweekStatsUpToTarget: stats,
      targetGameweek: gwNum,
      useSnapshotStatus: gwNum === maxTargetGw,
    });
    lastEvaluations = evaluations;

    const computedAt = gwRecord.deadlineTime ?? new Date(Date.UTC(opts.startYear, 7, 15 + gwNum * 7));
    const source = opts.source ?? FairValueSource.GAMEWEEK;

    // Delete any existing GAMEWEEK FairValue and VALUATION PriceTick at this exact computedAt/gameweekId for idempotency
    await db.fairValue.deleteMany({
      where: { gameweekId: gwRecord.id, source },
    });

    const fvData = evaluations.map((ev) => {
      const asset = playerAssetByPsId.get(ev.playerSeasonId)!;
      return {
        assetId: asset.id,
        gameweekId: gwRecord.id,
        source,
        value: ev.decimals.value,
        baseline: ev.decimals.baseline,
        form: ev.decimals.form,
        availabilityMult: ev.decimals.availabilityMult,
        positionBase: ev.decimals.positionBase,
        computedAt,
      };
    });

    // Club fair values at this gameweek
    const playersByClub = new Map<number, EvaluatedPlayerValuation[]>();
    for (const ev of evaluations) {
      const list = playersByClub.get(ev.clubSeasonId) ?? [];
      list.push(ev);
      playersByClub.set(ev.clubSeasonId, list);
    }

    const clubFixturesUpToGw = fixtures.filter(
      (f) => (f.gameweek?.number ?? 0) > 0 && (f.gameweek?.number ?? 0) <= gwNum,
    );

    for (const cs of clubSeasons) {
      const asset = clubAssetByCsId.get(cs.id)!;
      const squad = (playersByClub.get(cs.id) ?? []).map((p) => ({
        fairValue: p.value,
        minutes: p.minutes,
      }));

      // Last 6 matches points-per-game for this club
      const cMatches = clubFixturesUpToGw
        .filter((f) => f.homeClubSeasonId === cs.id || f.awayClubSeasonId === cs.id)
        .slice(-6);
      let pts = 0;
      for (const m of cMatches) {
        if (m.homeScore == null || m.awayScore == null) continue;
        const isHome = m.homeClubSeasonId === cs.id;
        const gf = isHome ? m.homeScore : m.awayScore;
        const ga = isHome ? m.awayScore : m.homeScore;
        if (gf > ga) pts += 3;
        else if (gf === ga) pts += 1;
      }
      const ppg = cMatches.length > 0 ? pts / cMatches.length : 1.38;

      const cfv = clubFairValue({
        squad,
        recentPointsPerGame: ppg,
        strengthOverallHome: cs.strengthOverallHome,
        strengthOverallAway: cs.strengthOverallAway,
      });

      fvData.push({
        assetId: asset.id,
        gameweekId: gwRecord.id,
        source,
        value: cfv.decimalValue,
        baseline: null as unknown as typeof fvData[0]['baseline'],
        form: null as unknown as typeof fvData[0]['form'],
        availabilityMult: null as unknown as typeof fvData[0]['availabilityMult'],
        positionBase: null as unknown as typeof fvData[0]['positionBase'],
        computedAt,
      });
    }

    await db.fairValue.createMany({ data: fvData });
    fairValuesWritten += fvData.length;

    // Also write corresponding VALUATION PriceTick rows (P = V * exp((q - q0)/L))
    await db.priceTick.deleteMany({
      where: { source: PriceTickSource.VALUATION, computedAt },
    });

    const tickData = fvData.map((fv) => {
      // Find asset inventory
      let inv = 0;
      let seedInv = 0;
      let liq = 500;
      for (const a of playerAssetByPsId.values()) {
        if (a.id === fv.assetId) {
          inv = a.inventory;
          seedInv = a.seedInventory;
          liq = a.liquidity;
          break;
        }
      }
      for (const a of clubAssetByCsId.values()) {
        if (a.id === fv.assetId) {
          inv = a.inventory;
          seedInv = a.seedInventory;
          liq = a.liquidity;
          break;
        }
      }
      const vNum = Number(fv.value);
      const pNum = vNum * Math.exp((inv - seedInv) / Math.max(1, liq));
      return {
        assetId: fv.assetId,
        source: PriceTickSource.VALUATION,
        price: toPriceDecimal(pNum),
        fairValue: fv.value,
        inventory: inv,
        computedAt,
      };
    });

    await db.priceTick.createMany({ data: tickData });
    priceTicksWritten += tickData.length;
  }

  return {
    assetsCreated,
    fairValuesWritten,
    priceTicksWritten,
    playerValuations: lastEvaluations,
  };
}
