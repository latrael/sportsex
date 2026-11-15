/**
 * Phase 5 (R5.1–R5.7) — Integration tests for UI queries, search/sort/pagination,
 * position discovery, price history, ledger-backed portfolio/leaderboards,
 * TradeWidget exact quote parity, and v1 engine-room removal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PlayerPosition, PriceTickSource } from '@prisma/client';
import {
  db,
  cleanDb,
  createUser,
  createTeam,
  createPlayer,
  createValuation,
  createTeamValuation,
} from '../helpers';
import {
  getMarketPlayerDetail,
  getMarketClubDetail,
  latestPrice,
  latestPricesByPlayerIds,
  priceHistoryForAsset,
  queryMarketClubs,
  queryMarketPlayers,
  topMovers,
} from '@/lib/queries';
import {
  executeAmmOrder,
  getLeaderboardRankings,
  getUserPortfolioSummary,
  quoteTradePure,
} from '@/lib/market';
import { toPriceDecimal } from '@/lib/money';
import { lastOrderAt } from '@/lib/cooldown';

beforeEach(async () => {
  await cleanDb();
  lastOrderAt.clear();
});

describe('R5.1 — Consistent latest price ordering & O(assets) topMovers', () => {
  it('list and detail queries agree on every player price even on identical computedAt timestamps', async () => {
    const p1 = await createPlayer(undefined, {
      firstName: 'Bukayo',
      secondName: 'Saka',
      webName: 'Saka',
      position: PlayerPosition.MID,
    });
    const tick1 = await createValuation(p1.id, 120);

    // Insert two ticks at the exact same timestamp; the higher-id tick (185.50) must win everywhere
    const sameTime = new Date(Date.now() + 10_000);
    await db.priceTick.create({
      data: {
        assetId: tick1.assetId,
        source: PriceTickSource.VALUATION,
        price: toPriceDecimal(140.25),
        fairValue: toPriceDecimal(140.25),
        inventory: 0,
        computedAt: sameTime,
      },
    });
    await db.priceTick.create({
      data: {
        assetId: tick1.assetId,
        source: PriceTickSource.TRADE,
        price: toPriceDecimal(185.5),
        fairValue: toPriceDecimal(140.25),
        inventory: 50,
        computedAt: sameTime,
      },
    });

    const [singlePrice, batchMap, marketList, detail, history] = await Promise.all([
      latestPrice('player', p1.id),
      latestPricesByPlayerIds([p1.id]),
      queryMarketPlayers({ q: 'saka' }),
      getMarketPlayerDetail(p1.id),
      priceHistoryForAsset(tick1.assetId),
    ]);

    expect(singlePrice).toBe(185.5);
    expect(batchMap.get(p1.id)).toBe(185.5);
    expect(marketList.items[0]?.price).toBe(185.5);
    expect(detail?.price).toBe(185.5);
    expect(history[history.length - 1]?.price).toBe(185.5);
  });

  it('topMovers computes 24h percentage change in SQL via DISTINCT ON (assetId)', async () => {
    const pUp = await createPlayer(undefined, { firstName: 'Cole', secondName: 'Palmer', webName: 'Palmer' });
    const pDown = await createPlayer(undefined, { firstName: 'Phil', secondName: 'Foden', webName: 'Foden' });
    const pFlat = await createPlayer(undefined, { firstName: 'Declan', secondName: 'Rice', webName: 'Rice' });

    const tUp = await createValuation(pUp.id, 100);
    const tDown = await createValuation(pDown.id, 200);
    await createValuation(pFlat.id, 150);

    // Move Palmer +30% (100 -> 130) and Foden -20% (200 -> 160)
    await db.priceTick.create({
      data: {
        assetId: tUp.assetId,
        source: PriceTickSource.TRADE,
        price: toPriceDecimal(130),
        fairValue: toPriceDecimal(100),
        inventory: 100,
        computedAt: new Date(Date.now() + 5000),
      },
    });
    await db.priceTick.create({
      data: {
        assetId: tDown.assetId,
        source: PriceTickSource.TRADE,
        price: toPriceDecimal(160),
        fairValue: toPriceDecimal(200),
        inventory: -100,
        computedAt: new Date(Date.now() + 5000),
      },
    });

    const movers = await topMovers(5);
    expect(movers.length).toBe(2);
    expect(movers[0].playerId).toBe(pUp.id);
    expect(movers[0].pct).toBeCloseTo(0.3, 4);
    expect(movers[1].playerId).toBe(pDown.id);
    expect(movers[1].pct).toBeCloseTo(-0.2, 4);
  });
});

describe('R5.2 & R5.4 — Case-insensitive search, full-universe price sort, pagination, and position discovery', () => {
  it('searching "haaland" (case-insensitive) finds Erling Haaland', async () => {
    const haaland = await createPlayer(undefined, {
      firstName: 'Erling',
      secondName: 'Haaland',
      webName: 'Haaland',
      position: PlayerPosition.FWD,
      goals: 27,
    });
    await createValuation(haaland.id, 375);

    const lower = await queryMarketPlayers({ q: 'haaland' });
    const upper = await queryMarketPlayers({ q: 'HAALAND' });
    const full = await queryMarketPlayers({ q: 'erling haaland' });

    expect(lower.total).toBe(1);
    expect(lower.items[0].id).toBe(haaland.id);
    expect(upper.items[0].id).toBe(haaland.id);
    expect(full.items[0].id).toBe(haaland.id);
  });

  it('sorts by price across the full universe (not a 200-row alphabetical slice) and paginates beyond 200 rows', async () => {
    const team = await createTeam('Arsenal');

    // Create 210 players: 205 cheap "Aaron-001..205" players and 1 expensive "Zlatan-999" player
    for (let i = 1; i <= 205; i++) {
      const p = await createPlayer(team.id, {
        firstName: 'Aaron',
        secondName: `Player-${String(i).padStart(3, '0')}`,
        webName: `Aaron-${String(i).padStart(3, '0')}`,
        position: PlayerPosition.MID,
      });
      await createValuation(p.id, 40 + (i % 10));
    }

    const expensiveZ = await createPlayer(team.id, {
      firstName: 'Zlatan',
      secondName: 'ZzzTopValued',
      webName: 'ZzzTopValued',
      position: PlayerPosition.FWD,
    });
    await createValuation(expensiveZ.id, 950);

    // Sort: Price page 1 must have Zlatan first even though alphabetically he is #206!
    const page1 = await queryMarketPlayers({ sort: 'price', page: 1, pageSize: 50 });
    expect(page1.total).toBe(206);
    expect(page1.totalPages).toBe(5);
    expect(page1.items[0].id).toBe(expensiveZ.id);
    expect(page1.items[0].price).toBe(950);

    // Page 5 reaches rows 201..206 (beyond 200)
    const page5 = await queryMarketPlayers({ sort: 'price', page: 5, pageSize: 50 });
    expect(page5.items.length).toBe(6);
  });

  it('provides browsable, sortable surfaces for all four position groups (GK/DEF/MID/FWD)', async () => {
    const gk = await createPlayer(undefined, {
      firstName: 'David',
      secondName: 'Raya',
      webName: 'Raya',
      position: PlayerPosition.GKP,
      cleanSheets: 16,
      saves: 95,
    });
    const def = await createPlayer(undefined, {
      firstName: 'Gabriel',
      secondName: 'Magalhaes',
      webName: 'Gabriel',
      position: PlayerPosition.DEF,
      cleanSheets: 16,
      goals: 5,
    });
    const mid = await createPlayer(undefined, {
      firstName: 'Bruno',
      secondName: 'Fernandes',
      webName: 'B.Fernandes',
      position: PlayerPosition.MID,
      goals: 12,
      assists: 14,
    });
    const fwd = await createPlayer(undefined, {
      firstName: 'Ollie',
      secondName: 'Watkins',
      webName: 'Watkins',
      position: PlayerPosition.FWD,
      goals: 19,
    });

    await Promise.all([
      createValuation(gk.id, 240),
      createValuation(def.id, 375),
      createValuation(mid.id, 877),
      createValuation(fwd.id, 391),
    ]);

    const gkView = await queryMarketPlayers({ pos: 'GK', sort: 'saves' });
    const gkpView = await queryMarketPlayers({ pos: 'GKP', sort: 'price' });
    const defView = await queryMarketPlayers({ pos: 'DEF', sort: 'cleanSheets' });
    const midView = await queryMarketPlayers({ pos: 'MID', sort: 'price' });
    const fwdView = await queryMarketPlayers({ pos: 'FWD', sort: 'goals' });

    expect(gkView.items.map((x) => x.id)).toEqual([gk.id]);
    expect(gkpView.items.map((x) => x.id)).toEqual([gk.id]);
    expect(defView.items.map((x) => x.id)).toEqual([def.id]);
    expect(midView.items.map((x) => x.id)).toEqual([mid.id]);
    expect(fwdView.items.map((x) => x.id)).toEqual([fwd.id]);
    expect(gkView.positionCounts).toEqual({
      ALL: 4,
      GKP: 1,
      DEF: 1,
      MID: 1,
      FWD: 1,
    });
  });
});

describe('R5.3 — Player and club price history never empty', () => {
  it('returns multi-week price history for players and clubs', async () => {
    const club = await createTeam('Liverpool');
    const player = await createPlayer(club.id, {
      firstName: 'Mohamed',
      secondName: 'Salah',
      webName: 'M.Salah',
    });

    const pTick = await createValuation(player.id, 320);
    const cTick = await createTeamValuation(club.id, 260);

    // Add a second gameweek tick
    await db.priceTick.create({
      data: {
        assetId: pTick.assetId,
        source: PriceTickSource.VALUATION,
        price: toPriceDecimal(345),
        fairValue: toPriceDecimal(345),
        inventory: 0,
        computedAt: new Date(Date.now() + 60_000),
      },
    });

    const pHistory = await priceHistoryForAsset(pTick.assetId);
    const cHistory = await priceHistoryForAsset(cTick.assetId);
    const clubsList = await queryMarketClubs('price');
    const clubDetail = await getMarketClubDetail(club.id);

    expect(pHistory.length).toBeGreaterThanOrEqual(2);
    expect(cHistory.length).toBeGreaterThanOrEqual(1);
    expect(clubsList[0].id).toBe(club.id);
    expect(clubDetail?.roster[0].id).toBe(player.id);
  });
});

describe('R5.5 & R5.6 — Ledger-backed portfolio/leaderboards and exact TradeWidget quote parity', () => {
  it('TradeWidget quote matches filled order cost to the last minor unit, and portfolio net worth equals ledger cash + mark-to-market positions', async () => {
    const user = await createUser({ coinBalance: 10000 });
    const player = await createPlayer(undefined, {
      firstName: 'Alexander',
      secondName: 'Isak',
      webName: 'Isak',
    });
    await createValuation(player.id, 250);

    const detailBefore = await getMarketPlayerDetail(player.id);
    expect(detailBefore).not.toBeNull();

    // 1. Quote 12 shares using the exact client helper (`quoteTradePure`)
    const clientQuote = quoteTradePure(
      {
        fairValue: detailBefore!.fairValue,
        inventory: detailBefore!.inventory,
        seedInventory: detailBefore!.seedInventory,
        liquidity: detailBefore!.liquidity,
      },
      'buy',
      12,
    );

    // 2. Execute the order on the server
    const fill = await executeAmmOrder(db, {
      userId: user.id,
      assetKind: 'player',
      assetId: player.id,
      side: 'buy',
      shares: 12,
    });

    // R5.6 Acceptance: quoted cost matches filled cost to the last minor unit!
    expect(fill.quote.grossCostMinor).toBe(clientQuote.grossCostMinor);
    expect(fill.quote.feeMinor).toBe(clientQuote.feeMinor);
    expect(fill.quote.totalUserCashMinor).toBe(clientQuote.totalUserCashMinor);
    expect(fill.coinsDeltaMinor).toBe(clientQuote.userNetCashDeltaMinor);
    expect(fill.price).toBeCloseTo(clientQuote.avgExecutionPrice, 4);

    // R5.5 Acceptance: portfolio net worth === ledger cash balance + mark-to-market positions
    const portfolio = await getUserPortfolioSummary(user.id);
    expect(portfolio.balanceMinor).toBe(fill.balanceAfterMinor);
    expect(portfolio.positions.length).toBe(1);
    const expectedMtm = Number(fill.quote.decimals.spotPriceAfter) * 12;
    expect(portfolio.holdingsValue).toBeCloseTo(expectedMtm, 4);
    expect(portfolio.netWorth).toBeCloseTo(portfolio.cashBalance + portfolio.holdingsValue, 6);

    const lb = await getLeaderboardRankings([user.id]);
    expect(lb.length).toBe(1);
    expect(lb[0].cashBalance).toBeCloseTo(portfolio.cashBalance, 6);
    expect(lb[0].holdingsValue).toBeCloseTo(portfolio.holdingsValue, 6);
    expect(lb[0].netWorth).toBeCloseTo(portfolio.netWorth, 6);
  });
});

describe('R5.7 — v1 engine-room models removed and FplPlayer renamed to Player', () => {
  it('Prisma client exposes v2 Player and has no v1 engine-room models', () => {
    const clientKeys = Object.keys(db);
    expect(clientKeys).not.toContain('fplPlayer');
    expect(clientKeys).not.toContain('team');
    expect(clientKeys).not.toContain('match');
    expect(clientKeys).not.toContain('playerMatchStat');
    expect(clientKeys).not.toContain('valuation');
    expect(clientKeys).not.toContain('holding');
    expect(clientKeys).not.toContain('order');
    expect(typeof db.player.findMany).toBe('function');
    expect(typeof db.club.findMany).toBe('function');
    expect(typeof db.fixture.findMany).toBe('function');
  });
});
