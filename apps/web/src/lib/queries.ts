/**
 * R5.1, R5.2, R5.4 — Market & reference queries on the v2 schema.
 *
 * Canonical "latest price" rule (enforced everywhere):
 *   Newest `price_tick` row ordered by `("computedAt" DESC, "id" DESC)` for the
 *   asset, falling back to the newest `fair_value` row ordered by
 *   `("computedAt" DESC, "id" DESC)`, and finally `50` if unseeded.
 *
 * Because both list queries (`latestPricesByAssetIds`, `queryMarketPlayers`)
 * and detail queries (`latestPriceByAssetId`, `priceHistoryForAsset`) use the
 * exact same `ORDER BY "computedAt" DESC, id DESC` tie-breaker, list and detail
 * pages always agree on every player's and club's price.
 */

import { AssetKind as PrismaAssetKind, PlayerPosition, Prisma } from '@prisma/client';
import { prisma } from './db';

export type AssetKind = 'player' | 'team';

export interface TopMoverRow {
  assetId: number;
  playerId: number;
  playerSeasonId: number;
  webName: string;
  fullName: string;
  position: PlayerPosition;
  clubName: string;
  clubShortName: string;
  latest: number;
  prior: number;
  pct: number;
}

export interface MarketPlayerRow {
  /** `player.id` (canonical URL & Comment FK id). */
  id: number;
  playerSeasonId: number;
  assetId: number | null;
  webName: string;
   fullName: string;
  position: PlayerPosition;
  /** 'GK' | 'DEF' | 'MID' | 'FWD' for UI badge compatibility, plus raw position. */
  posBucket: string;
  status: string;
  clubId: number;
  clubName: string;
  clubShortName: string;
  appearances: number;
  minutes: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  saves: number;
  totalPoints: number;
  price: number;
  fairValue: number;
  inventory: number;
  seedInventory: number;
  liquidity: number;
}

export interface MarketClubRow {
  /** `club.id` (canonical URL id). */
  id: number;
  clubSeasonId: number;
  assetId: number | null;
  name: string;
  shortName: string;
  playerCount: number;
  price: number;
  fairValue: number;
  inventory: number;
  seedInventory: number;
  liquidity: number;
}

export interface PriceChartPoint {
  t: string;
  computedAt: Date;
  price: number;
  fairValue: number;
  source: string;
}

export function normalizePosFilter(pos?: string | null): PlayerPosition | null {
  if (!pos || pos === 'ALL') return null;
  const upper = pos.toUpperCase().trim();
  if (upper === 'GK' || upper === 'GKP') return PlayerPosition.GKP;
  if (upper === 'DEF') return PlayerPosition.DEF;
  if (upper === 'MID') return PlayerPosition.MID;
  if (upper === 'FWD') return PlayerPosition.FWD;
  return null;
}

export function formatPosBadge(pos: PlayerPosition | string): string {
  if (pos === 'GKP' || pos === 'GK') return 'GK';
  return String(pos);
}

/**
 * Latest prices for a batch of `asset.id` values using the single canonical
 * ordering rule: `ORDER BY "assetId", "computedAt" DESC, id DESC`.
 */
export async function latestPricesByAssetIds(assetIds: number[]): Promise<Map<number, number>> {
  const uniqueIds = Array.from(new Set(assetIds.filter((x) => Number.isInteger(x) && x > 0)));
  if (uniqueIds.length === 0) return new Map();

  const tickRows = await prisma.$queryRaw<{ assetId: number; price: Prisma.Decimal }[]>`
    SELECT DISTINCT ON ("assetId") "assetId", price
    FROM price_tick
    WHERE "assetId" = ANY(${uniqueIds}::integer[])
    ORDER BY "assetId", "computedAt" DESC, id DESC
  `;

  const map = new Map<number, number>();
  for (const r of tickRows) {
    map.set(r.assetId, Number(r.price));
  }

  const missingIds = uniqueIds.filter((id) => !map.has(id));
  if (missingIds.length > 0) {
    const fvRows = await prisma.$queryRaw<{ assetId: number; value: Prisma.Decimal }[]>`
      SELECT DISTINCT ON ("assetId") "assetId", value
      FROM fair_value
      WHERE "assetId" = ANY(${missingIds}::integer[])
      ORDER BY "assetId", "computedAt" DESC, id DESC
    `;
    for (const r of fvRows) {
      map.set(r.assetId, Number(r.value));
    }
  }

  return map;
}

/**
 * Latest price for a single `asset.id` using the canonical ordering rule.
 */
export async function latestPriceByAssetId(assetId: number): Promise<number> {
  const map = await latestPricesByAssetIds([assetId]);
  return map.get(assetId) ?? 50;
}

/**
 * Resolve `player.id` / `player_season.id` / `asset.id` to canonical latest prices.
 */
export async function latestPricesByPlayerIds(ids: number[]): Promise<Map<number, number>> {
  const uniqueIds = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)));
  if (uniqueIds.length === 0) return new Map();

  const assets = await prisma.asset.findMany({
    where: {
      kind: PrismaAssetKind.PLAYER,
      OR: [
        { id: { in: uniqueIds } },
        { playerSeasonId: { in: uniqueIds } },
        { playerSeason: { playerId: { in: uniqueIds } } },
      ],
    },
    select: {
      id: true,
      playerSeasonId: true,
      playerSeason: { select: { playerId: true } },
    },
  });

  const priceByAssetId = await latestPricesByAssetIds(assets.map((a) => a.id));
  const result = new Map<number, number>();

  for (const a of assets) {
    const p = priceByAssetId.get(a.id) ?? 50;
    result.set(a.id, p);
    if (a.playerSeasonId != null) result.set(a.playerSeasonId, p);
    if (a.playerSeason?.playerId != null) result.set(a.playerSeason.playerId, p);
  }

  return result;
}

/**
 * Resolve `club.id` / `club_season.id` / `asset.id` to canonical latest prices.
 */
export async function latestPricesByTeamIds(ids: number[]): Promise<Map<number, number>> {
  const uniqueIds = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)));
  if (uniqueIds.length === 0) return new Map();

  const assets = await prisma.asset.findMany({
    where: {
      kind: PrismaAssetKind.CLUB,
      OR: [
        { id: { in: uniqueIds } },
        { clubSeasonId: { in: uniqueIds } },
        { clubSeason: { clubId: { in: uniqueIds } } },
      ],
    },
    select: {
      id: true,
      clubSeasonId: true,
      clubSeason: { select: { clubId: true } },
    },
  });

  const priceByAssetId = await latestPricesByAssetIds(assets.map((a) => a.id));
  const result = new Map<number, number>();

  for (const a of assets) {
    const p = priceByAssetId.get(a.id) ?? 50;
    result.set(a.id, p);
    if (a.clubSeasonId != null) result.set(a.clubSeasonId, p);
    if (a.clubSeason?.clubId != null) result.set(a.clubSeason.clubId, p);
  }

  return result;
}

/**
 * Latest price for a single player or team (`id` may be `player.id`/`club.id`,
 * `player_season.id`/`club_season.id`, or `asset.id`).
 */
export async function latestPrice(kind: AssetKind, id: number): Promise<number> {
  const map =
    kind === 'player' ? await latestPricesByPlayerIds([id]) : await latestPricesByTeamIds([id]);
  return map.get(id) ?? 50;
}

/**
 * Price history for an asset (`PriceTick` rows, supplemented by `FairValue`
 * gameweek history if needed), ordered chronologically so the final point is
 * guaranteed to match `latestPriceByAssetId(assetId)`.
 */
export async function priceHistoryForAsset(
  assetId: number,
  limit = 200,
): Promise<PriceChartPoint[]> {
  // Fetch the newest `limit` ticks using the canonical DESC ordering, then reverse
  const ticksDesc = await prisma.priceTick.findMany({
    where: { assetId },
    orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });

  if (ticksDesc.length > 0) {
    const chronological = [...ticksDesc].reverse();
    return chronological.map((pt) => ({
      t: new Date(pt.computedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }),
      computedAt: pt.computedAt,
      price: Number(pt.price),
      fairValue: Number(pt.fairValue),
      source: pt.source,
    }));
  }

  // Fallback to FairValue history if no PriceTicks exist yet
  const fvsDesc = await prisma.fairValue.findMany({
    where: { assetId },
    orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });

  return [...fvsDesc].reverse().map((fv) => ({
    t: new Date(fv.computedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    computedAt: fv.computedAt,
    price: Number(fv.value),
    fairValue: Number(fv.value),
    source: fv.source,
  }));
}

/**
 * Net buys in shares over the last 24h for a player or asset.
 */
export async function netBuys24hForPlayer(playerOrAssetId: number): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const asset = await prisma.asset.findFirst({
    where: {
      kind: PrismaAssetKind.PLAYER,
      OR: [
        { id: playerOrAssetId },
        { playerSeasonId: playerOrAssetId },
        { playerSeason: { playerId: playerOrAssetId } },
      ],
    },
    select: { id: true },
  });
  if (!asset) return 0;

  const trades = await prisma.trade.findMany({
    where: {
      assetId: asset.id,
      createdAt: { gte: since },
    },
    select: { side: true, shares: true },
  });

  let net = 0;
  for (const t of trades) {
    net += t.side === 'BUY' ? t.shares : -t.shares;
  }
  return net;
}

/**
 * R5.1 — O(assets) top movers query.
 *
 * Uses `DISTINCT ON ("assetId")` in Postgres to compare each player asset's
 * canonical latest price against its prior price (either the latest tick at or
 * before `now - 24h`, or the previous tick if the asset's history is newer or
 * gameweek-grained). Never pulls all ticks into Node memory.
 */
export async function topMovers(limit = 10): Promise<TopMoverRow[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await prisma.$queryRaw<
    {
      assetId: number;
      playerId: number;
      playerSeasonId: number;
      webName: string;
      firstName: string;
      secondName: string;
      position: PlayerPosition;
      clubName: string;
      clubShortName: string;
      latestPrice: Prisma.Decimal;
      priorPrice: Prisma.Decimal;
    }[]
  >`
    WITH latest_tick AS (
      SELECT DISTINCT ON ("assetId")
        "assetId",
        id AS latest_id,
        price AS latest_price,
        "computedAt" AS latest_at
      FROM price_tick
      ORDER BY "assetId", "computedAt" DESC, id DESC
    ),
    prior_24h AS (
      SELECT DISTINCT ON (pt."assetId")
        pt."assetId",
        pt.price AS prior_price
      FROM price_tick pt
      WHERE pt."computedAt" <= ${since}
      ORDER BY pt."assetId", pt."computedAt" DESC, pt.id DESC
    ),
    prev_tick AS (
      SELECT DISTINCT ON (pt."assetId")
        pt."assetId",
        pt.price AS prev_price
      FROM price_tick pt
      INNER JOIN latest_tick lt ON lt."assetId" = pt."assetId"
      WHERE pt.id <> lt.latest_id
      ORDER BY pt."assetId", pt."computedAt" DESC, pt.id DESC
    ),
    mover_calc AS (
      SELECT
        lt."assetId",
        lt.latest_price,
        COALESCE(p24.prior_price, prev.prev_price) AS prior_price
      FROM latest_tick lt
      LEFT JOIN prior_24h p24 ON p24."assetId" = lt."assetId"
      LEFT JOIN prev_tick prev ON prev."assetId" = lt."assetId"
      WHERE COALESCE(p24.prior_price, prev.prev_price) IS NOT NULL
        AND COALESCE(p24.prior_price, prev.prev_price) > 0
        AND lt.latest_price <> COALESCE(p24.prior_price, prev.prev_price)
    )
    SELECT
      mc."assetId" AS "assetId",
      p.id AS "playerId",
      ps.id AS "playerSeasonId",
      p."webName" AS "webName",
      p."firstName" AS "firstName",
      p."secondName" AS "secondName",
      ps.position AS "position",
      c.name AS "clubName",
      c."shortName" AS "clubShortName",
      mc.latest_price AS "latestPrice",
      mc.prior_price AS "priorPrice"
    FROM mover_calc mc
    INNER JOIN asset a ON a.id = mc."assetId" AND a.kind = 'PLAYER'
    INNER JOIN player_season ps ON ps.id = a."playerSeasonId"
    INNER JOIN player p ON p.id = ps."playerId"
    INNER JOIN club_season cs ON cs.id = ps."clubSeasonId"
    INNER JOIN club c ON c.id = cs."clubId"
    ORDER BY ABS((mc.latest_price - mc.prior_price) / mc.prior_price) DESC, mc."assetId" ASC
    LIMIT ${limit}
  `;

  return rows.map((r) => {
    const latest = Number(r.latestPrice);
    const prior = Number(r.priorPrice);
    const pct = prior > 0 ? (latest - prior) / prior : 0;
    return {
      assetId: r.assetId,
      playerId: r.playerId,
      playerSeasonId: r.playerSeasonId,
      webName: r.webName,
      fullName: `${r.firstName} ${r.secondName}`.trim(),
      position: r.position,
      clubName: r.clubName,
      clubShortName: r.clubShortName,
      latest,
      prior,
      pct,
    };
  });
}

export interface QueryMarketPlayersInput {
  q?: string;
  pos?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
  seasonStartYear?: number;
}

export interface QueryMarketPlayersOutput {
  items: MarketPlayerRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  positionCounts: Record<'ALL' | 'GKP' | 'DEF' | 'MID' | 'FWD', number>;
}

/**
 * R5.2 & R5.4 — Full-universe player market query with:
 *   - Case-insensitive search (`ILIKE`) across `webName`, `firstName`, `secondName`,
 *     `firstName || ' ' || secondName`, and `club.name`
 *   - Position filtering (`ALL`, `GKP`/`GK`, `DEF`, `MID`, `FWD`)
 *   - Full-universe sorting by `price`, `goals`, `assists`, `minutes`, `points`,
 *     `cleanSheets`, `saves`, or `name` BEFORE pagination
 *   - Pagination (`page`, `pageSize`) beyond 200 rows across all 841+ players
 */
export async function queryMarketPlayers(
  input: QueryMarketPlayersInput = {},
): Promise<QueryMarketPlayersOutput> {
  const q = (input.q ?? '').trim();
  const posEnum = normalizePosFilter(input.pos);
  const sort = input.sort ?? 'price';
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 200);
  const page = Math.max(input.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  // Find target season (latest startYear by default)
  const season = input.seasonStartYear
    ? await prisma.season.findUnique({ where: { startYear: input.seasonStartYear } })
    : await prisma.season.findFirst({ orderBy: { startYear: 'desc' } });

  if (!season) {
    return {
      items: [],
      total: 0,
      page,
      pageSize,
      totalPages: 0,
      positionCounts: { ALL: 0, GKP: 0, DEF: 0, MID: 0, FWD: 0 },
    };
  }

  const searchPattern = q ? `%${q}%` : null;

  const whereClauses: Prisma.Sql[] = [Prisma.sql`ps."seasonId" = ${season.id}`];
  if (posEnum) {
    whereClauses.push(Prisma.sql`ps.position = ${posEnum}::"PlayerPosition"`);
  }
  if (searchPattern) {
    whereClauses.push(
      Prisma.sql`(
        p."webName" ILIKE ${searchPattern}
        OR p."firstName" ILIKE ${searchPattern}
        OR p."secondName" ILIKE ${searchPattern}
        OR (p."firstName" || ' ' || p."secondName") ILIKE ${searchPattern}
        OR c.name ILIKE ${searchPattern}
        OR c."shortName" ILIKE ${searchPattern}
      )`,
    );
  }
  const whereSql = Prisma.join(whereClauses, ' AND ');

  let orderBySql: Prisma.Sql;
  switch (sort) {
    case 'price':
      orderBySql = Prisma.sql`eff_price DESC, COALESCE(pss."totalPoints", 0) DESC, p.id ASC`;
      break;
    case 'goals':
      orderBySql = Prisma.sql`COALESCE(pss."goalsScored", 0) DESC, COALESCE(pss.assists, 0) DESC, eff_price DESC, p.id ASC`;
      break;
    case 'assists':
      orderBySql = Prisma.sql`COALESCE(pss.assists, 0) DESC, COALESCE(pss."goalsScored", 0) DESC, eff_price DESC, p.id ASC`;
      break;
    case 'minutes':
      orderBySql = Prisma.sql`COALESCE(pss.minutes, 0) DESC, eff_price DESC, p.id ASC`;
      break;
    case 'points':
      orderBySql = Prisma.sql`COALESCE(pss."totalPoints", 0) DESC, eff_price DESC, p.id ASC`;
      break;
    case 'cleanSheets':
      orderBySql = Prisma.sql`COALESCE(pss."cleanSheets", 0) DESC, eff_price DESC, p.id ASC`;
      break;
    case 'saves':
      orderBySql = Prisma.sql`COALESCE(pss.saves, 0) DESC, eff_price DESC, p.id ASC`;
      break;
    case 'name':
      orderBySql = Prisma.sql`p."webName" ASC, p."secondName" ASC, p.id ASC`;
      break;
    default:
      orderBySql = Prisma.sql`eff_price DESC, COALESCE(pss."totalPoints", 0) DESC, p.id ASC`;
      break;
  }

  const [countRows, posCountRows, dataRows] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM player_season ps
      INNER JOIN player p ON p.id = ps."playerId"
      INNER JOIN club_season cs ON cs.id = ps."clubSeasonId"
      INNER JOIN club c ON c.id = cs."clubId"
      WHERE ${whereSql}
    `,
    prisma.$queryRaw<{ position: PlayerPosition; count: bigint }[]>`
      SELECT ps.position AS position, COUNT(*)::bigint AS count
      FROM player_season ps
      WHERE ps."seasonId" = ${season.id}
      GROUP BY ps.position
    `,
    prisma.$queryRaw<
      {
        playerId: number;
        playerSeasonId: number;
        assetId: number | null;
        webName: string;
        firstName: string;
        secondName: string;
        position: PlayerPosition;
        status: string;
        clubId: number;
        clubName: string;
        clubShortName: string;
        appearances: number;
        minutes: number;
        goals: number;
        assists: number;
        cleanSheets: number;
        saves: number;
        totalPoints: number;
        effPrice: Prisma.Decimal;
        effFairValue: Prisma.Decimal;
        inventory: number;
        seedInventory: number;
        liquidity: Prisma.Decimal;
      }[]
    >`
      WITH latest_tick AS (
        SELECT DISTINCT ON ("assetId")
          "assetId",
          price,
          "fairValue"
        FROM price_tick
        ORDER BY "assetId", "computedAt" DESC, id DESC
      ),
      latest_fv AS (
        SELECT DISTINCT ON ("assetId")
          "assetId",
          value
        FROM fair_value
        ORDER BY "assetId", "computedAt" DESC, id DESC
      )
      SELECT
        p.id AS "playerId",
        ps.id AS "playerSeasonId",
        a.id AS "assetId",
        p."webName" AS "webName",
        p."firstName" AS "firstName",
        p."secondName" AS "secondName",
        ps.position AS "position",
        ps.status AS "status",
        c.id AS "clubId",
        c.name AS "clubName",
        c."shortName" AS "clubShortName",
        COALESCE(pss.appearances, 0) AS "appearances",
        COALESCE(pss.minutes, 0) AS "minutes",
        COALESCE(pss."goalsScored", 0) AS "goals",
        COALESCE(pss.assists, 0) AS "assists",
        COALESCE(pss."cleanSheets", 0) AS "cleanSheets",
        COALESCE(pss.saves, 0) AS "saves",
        COALESCE(pss."totalPoints", 0) AS "totalPoints",
        COALESCE(lt.price, lfv.value, 50::decimal) AS eff_price,
        COALESCE(lt.price, lfv.value, 50::decimal) AS "effPrice",
        COALESCE(lfv.value, lt."fairValue", 50::decimal) AS "effFairValue",
        COALESCE(a.inventory, 0) AS "inventory",
        COALESCE(a."seedInventory", 0) AS "seedInventory",
        COALESCE(a.liquidity, 2000::decimal) AS "liquidity"
      FROM player_season ps
      INNER JOIN player p ON p.id = ps."playerId"
      INNER JOIN club_season cs ON cs.id = ps."clubSeasonId"
      INNER JOIN club c ON c.id = cs."clubId"
      LEFT JOIN player_season_stat pss ON pss."playerSeasonId" = ps.id
      LEFT JOIN asset a ON a."playerSeasonId" = ps.id
      LEFT JOIN latest_tick lt ON lt."assetId" = a.id
      LEFT JOIN latest_fv lfv ON lfv."assetId" = a.id
      WHERE ${whereSql}
      ORDER BY ${orderBySql}
      LIMIT ${pageSize} OFFSET ${offset}
    `,
  ]);

  const total = Number(countRows[0]?.count ?? 0n);
  const positionCounts: Record<'ALL' | 'GKP' | 'DEF' | 'MID' | 'FWD', number> = {
    ALL: 0,
    GKP: 0,
    DEF: 0,
    MID: 0,
    FWD: 0,
  };
  for (const row of posCountRows) {
    const cnt = Number(row.count);
    positionCounts[row.position] = cnt;
    positionCounts.ALL += cnt;
  }

  const items: MarketPlayerRow[] = dataRows.map((r) => ({
    id: r.playerId,
    playerSeasonId: r.playerSeasonId,
    assetId: r.assetId,
    webName: r.webName,
    fullName: `${r.firstName} ${r.secondName}`.trim(),
    position: r.position,
    posBucket: formatPosBadge(r.position),
    status: r.status,
    clubId: r.clubId,
    clubName: r.clubName,
    clubShortName: r.clubShortName,
    appearances: r.appearances,
    minutes: r.minutes,
    goals: r.goals,
    assists: r.assists,
    cleanSheets: r.cleanSheets,
    saves: r.saves,
    totalPoints: r.totalPoints,
    price: Number(r.effPrice),
    fairValue: Number(r.effFairValue),
    inventory: r.inventory,
    seedInventory: r.seedInventory,
    liquidity: Number(r.liquidity),
  }));

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    positionCounts,
  };
}

/**
 * Look up a single player for `/players/[id]` (`id` may be `player.id`,
 * `player_season.id`, or `asset.id`), using the exact same price rule as list pages.
 */
export async function getMarketPlayerDetail(id: number): Promise<MarketPlayerRow | null> {
  const ps = await prisma.playerSeason.findFirst({
    where: {
      OR: [{ playerId: id }, { id }, { asset: { id } }],
    },
    orderBy: { season: { startYear: 'desc' } },
    include: {
      player: true,
      clubSeason: { include: { club: true } },
      seasonStat: true,
      asset: true,
    },
  });

  if (!ps) return null;

  let price = 50;
  let fairValue = 50;
  if (ps.asset) {
    const [latestTick, latestFv] = await Promise.all([
      prisma.priceTick.findFirst({
        where: { assetId: ps.asset.id },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      }),
      prisma.fairValue.findFirst({
        where: { assetId: ps.asset.id },
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    fairValue = latestFv ? Number(latestFv.value) : latestTick ? Number(latestTick.fairValue) : 50;
    price = latestTick ? Number(latestTick.price) : fairValue;
  }

  return {
    id: ps.player.id,
    playerSeasonId: ps.id,
    assetId: ps.asset?.id ?? null,
    webName: ps.player.webName,
    fullName: `${ps.player.firstName} ${ps.player.secondName}`.trim(),
    position: ps.position,
    posBucket: formatPosBadge(ps.position),
    status: ps.status,
    clubId: ps.clubSeason.club.id,
    clubName: ps.clubSeason.club.name,
    clubShortName: ps.clubSeason.club.shortName,
    appearances: ps.seasonStat?.appearances ?? 0,
    minutes: ps.seasonStat?.minutes ?? 0,
    goals: ps.seasonStat?.goalsScored ?? 0,
    assists: ps.seasonStat?.assists ?? 0,
    cleanSheets: ps.seasonStat?.cleanSheets ?? 0,
    saves: ps.seasonStat?.saves ?? 0,
    totalPoints: ps.seasonStat?.totalPoints ?? 0,
    price,
    fairValue,
    inventory: ps.asset?.inventory ?? 0,
    seedInventory: ps.asset?.seedInventory ?? 0,
    liquidity: ps.asset ? Number(ps.asset.liquidity) : 2000,
  };
}

/**
 * Query all clubs in the active season with their canonical latest prices.
 */
export async function queryMarketClubs(sort = 'name'): Promise<MarketClubRow[]> {
  const season = await prisma.season.findFirst({ orderBy: { startYear: 'desc' } });
  if (!season) return [];

  const clubSeasons = await prisma.clubSeason.findMany({
    where: { seasonId: season.id },
    include: {
      club: true,
      asset: true,
      _count: { select: { playerSeasons: true } },
    },
    orderBy: { club: { name: 'asc' } },
  });

  const assetIds = clubSeasons.map((cs) => cs.asset?.id).filter((id): id is number => id != null);
  const priceByAsset = await latestPricesByAssetIds(assetIds);

  const fvRows =
    assetIds.length > 0
      ? await prisma.$queryRaw<{ assetId: number; value: Prisma.Decimal }[]>`
          SELECT DISTINCT ON ("assetId") "assetId", value
          FROM fair_value
          WHERE "assetId" = ANY(${assetIds}::integer[])
          ORDER BY "assetId", "computedAt" DESC, id DESC
        `
      : [];
  const fvByAsset = new Map(fvRows.map((r) => [r.assetId, Number(r.value)]));

  const rows: MarketClubRow[] = clubSeasons.map((cs) => {
    const assetId = cs.asset?.id ?? null;
    const fv = assetId != null ? (fvByAsset.get(assetId) ?? 200) : 200;
    const price = assetId != null ? (priceByAsset.get(assetId) ?? fv) : fv;
    return {
      id: cs.club.id,
      clubSeasonId: cs.id,
      assetId,
      name: cs.club.name,
      shortName: cs.club.shortName,
      playerCount: cs._count.playerSeasons,
      price,
      fairValue: fv,
      inventory: cs.asset?.inventory ?? 0,
      seedInventory: cs.asset?.seedInventory ?? 0,
      liquidity: cs.asset ? Number(cs.asset.liquidity) : 800,
    };
  });

  if (sort === 'price') {
    rows.sort((a, b) => b.price - a.price || a.name.localeCompare(b.name));
  } else {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  return rows;
}

/**
 * Look up a single club and its roster for `/teams/[id]`.
 */
export async function getMarketClubDetail(id: number): Promise<{
  club: MarketClubRow;
  roster: MarketPlayerRow[];
} | null> {
  const cs = await prisma.clubSeason.findFirst({
    where: {
      OR: [{ clubId: id }, { id }, { asset: { id } }],
    },
    orderBy: { season: { startYear: 'desc' } },
    include: {
      club: true,
      asset: true,
      playerSeasons: {
        include: {
          player: true,
          seasonStat: true,
          asset: true,
        },
      },
    },
  });

  if (!cs) return null;

  const allAssetIds: number[] = [];
  if (cs.asset) allAssetIds.push(cs.asset.id);
  for (const ps of cs.playerSeasons) {
    if (ps.asset) allAssetIds.push(ps.asset.id);
  }

  const priceByAsset = await latestPricesByAssetIds(allAssetIds);
  const fvRows =
    allAssetIds.length > 0
      ? await prisma.$queryRaw<{ assetId: number; value: Prisma.Decimal }[]>`
          SELECT DISTINCT ON ("assetId") "assetId", value
          FROM fair_value
          WHERE "assetId" = ANY(${allAssetIds}::integer[])
          ORDER BY "assetId", "computedAt" DESC, id DESC
        `
      : [];
  const fvByAsset = new Map(fvRows.map((r) => [r.assetId, Number(r.value)]));

  const clubAssetId = cs.asset?.id ?? null;
  const clubFv = clubAssetId != null ? (fvByAsset.get(clubAssetId) ?? 200) : 200;
  const clubPrice = clubAssetId != null ? (priceByAsset.get(clubAssetId) ?? clubFv) : clubFv;

  const roster: MarketPlayerRow[] = cs.playerSeasons
    .map((ps) => {
      const aId = ps.asset?.id ?? null;
      const fv = aId != null ? (fvByAsset.get(aId) ?? 50) : 50;
      const pr = aId != null ? (priceByAsset.get(aId) ?? fv) : fv;
      return {
        id: ps.player.id,
        playerSeasonId: ps.id,
        assetId: aId,
        webName: ps.player.webName,
        fullName: `${ps.player.firstName} ${ps.player.secondName}`.trim(),
        position: ps.position,
        posBucket: formatPosBadge(ps.position),
        status: ps.status,
        clubId: cs.club.id,
        clubName: cs.club.name,
        clubShortName: cs.club.shortName,
        appearances: ps.seasonStat?.appearances ?? 0,
        minutes: ps.seasonStat?.minutes ?? 0,
        goals: ps.seasonStat?.goalsScored ?? 0,
        assists: ps.seasonStat?.assists ?? 0,
        cleanSheets: ps.seasonStat?.cleanSheets ?? 0,
        saves: ps.seasonStat?.saves ?? 0,
        totalPoints: ps.seasonStat?.totalPoints ?? 0,
        price: pr,
        fairValue: fv,
        inventory: ps.asset?.inventory ?? 0,
        seedInventory: ps.asset?.seedInventory ?? 0,
        liquidity: ps.asset ? Number(ps.asset.liquidity) : 2000,
      };
    })
    .sort((a, b) => b.minutes - a.minutes || b.price - a.price);

  return {
    club: {
      id: cs.club.id,
      clubSeasonId: cs.id,
      assetId: clubAssetId,
      name: cs.club.name,
      shortName: cs.club.shortName,
      playerCount: roster.length,
      price: clubPrice,
      fairValue: clubFv,
      inventory: cs.asset?.inventory ?? 0,
      seedInventory: cs.asset?.seedInventory ?? 0,
      liquidity: cs.asset ? Number(cs.asset.liquidity) : 800,
    },
    roster,
  };
}
