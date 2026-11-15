import { describe, it, expect, beforeEach } from 'vitest';
import { db, cleanDb, createUser } from '../helpers';
import {
  FplClient,
  parseBootstrapStatic,
} from '@/lib/fpl';
import { verifyCronRequest } from '@/lib/cronAuth';
import {
  runBootstrapCron,
  runFixturesCron,
  runLiveCron,
  runSettleCron,
  settleGameweek,
} from '@/lib/cron';
import {
  rolloverSeason,
  rollbackSeasonRollover,
} from '@/lib/rollover/seasonRollover';
import { executeAmmOrder } from '@/lib/market/trade';
import { getUserBalanceMinor, reconcileLedger } from '@/lib/market/ledger';
import { MINOR_UNITS_PER_COIN } from '@/lib/money';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';
import gw1Sample from '../fixtures/fpl/event-1-live.sample.json';

function makeMockFplClient(onCall?: (url: string) => void): FplClient {
  return new FplClient({
    baseUrl: 'https://fpl.test/api',
    sleep: async () => {},
    fetchImpl: async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      onCall?.(url);
      if (url.endsWith('/bootstrap-static/')) {
        return new Response(JSON.stringify(bootstrapSample), { status: 200 });
      }
      if (url.includes('/fixtures/')) {
        return new Response(JSON.stringify(fixturesSample), { status: 200 });
      }
      if (url.endsWith('/event/1/live/')) {
        return new Response(JSON.stringify(gw1Sample), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    },
  });
}

beforeEach(async () => {
  await cleanDb();
});

describe('Phase 6 — Automation & Season Rollover (R6.1–R6.6, R7.6)', () => {
  it('R6.5: verifyCronRequest fails closed when CRON_SECRET is unset, empty, or mismatched', async () => {
    const reqNoHeader = new Request('http://localhost/api/cron/bootstrap');
    const reqWrong = new Request('http://localhost/api/cron/bootstrap', {
      headers: { authorization: 'Bearer wrong-secret-value' },
    });
    const reqValid = new Request('http://localhost/api/cron/bootstrap', {
      headers: { authorization: 'Bearer test-cron-secret-2627' },
    });

    // Unset / empty / short secret -> 503 fail-closed
    expect(verifyCronRequest(reqValid, undefined)?.status).toBe(503);
    expect(verifyCronRequest(reqValid, '')?.status).toBe(503);
    expect(verifyCronRequest(reqValid, '   ')?.status).toBe(503);
    expect(verifyCronRequest(reqValid, 'short')?.status).toBe(503);

    // Missing or wrong token -> 401
    expect(verifyCronRequest(reqNoHeader, 'test-cron-secret-2627')?.status).toBe(401);
    expect(verifyCronRequest(reqWrong, 'test-cron-secret-2627')?.status).toBe(401);

    // Matching token -> null (allowed)
    expect(verifyCronRequest(reqValid, 'test-cron-secret-2627')).toBeNull();
  });

  it('R6.1–R6.4: full gameweek ingests, respects match windows, settles end-to-end, and re-settling is a strict no-op (Invariant 3)', async () => {
    const calledUrls: string[] = [];
    const client = makeMockFplClient((url) => calledUrls.push(url));

    // 1. R6.1 Daily bootstrap-static cron
    const bootRes = await runBootstrapCron(db, {
      client,
      now: new Date('2025-08-15T12:00:00Z'),
    });
    expect(bootRes.sync.season.startYear).toBe(2025);
    expect(bootRes.sync.players.created).toBeGreaterThan(0);
    expect(bootRes.raw).toBe('created');
    expect(bootRes.reprice?.assetsCreated).toBeGreaterThan(0);

    // Re-running bootstrap cron on identical payload is idempotent
    const bootRes2 = await runBootstrapCron(db, {
      client,
      now: new Date('2025-08-15T12:00:00Z'),
    });
    expect(bootRes2.sync.players.created).toBe(0);
    expect(bootRes2.sync.players.updated).toBe(0);
    expect(bootRes2.raw).toBe('unchanged');

    // 2. R6.2 Hourly fixtures cron
    const fixRes = await runFixturesCron(db, { client, startYear: 2025 });
    expect(fixRes.sync.fixtures.created).toBeGreaterThan(0);
    expect(fixRes.raw).toBe('created');

    // 3. R6.3 Live cron outside match windows -> skips without calling FPL
    const callsBeforeOutside = calledUrls.length;
    const outsideRes = await runLiveCron(db, {
      client,
      startYear: 2025,
      now: new Date('2025-07-01T12:00:00Z'), // weeks before any kickoff
    });
    expect(outsideRes.skipped).toBe(true);
    expect(outsideRes.reason).toBe('outside_match_window');
    expect(outsideRes.gameweeksPolled).toEqual([]);
    expect(calledUrls.length).toBe(callsBeforeOutside);

    // Find a GW1 fixture kickoff time to simulate an active match window
    const gw1Fixture = await db.fixture.findFirstOrThrow({
      where: { gameweek: { number: 1 }, kickoffTime: { not: null } },
      orderBy: { id: 'asc' },
    });
    const inWindowTime = new Date(gw1Fixture.kickoffTime!.getTime() + 30 * 60 * 1000);

    const insideRes = await runLiveCron(db, {
      client,
      startYear: 2025,
      now: inWindowTime,
    });
    expect(insideRes.skipped).toBe(false);
    expect(insideRes.gameweeksPolled).toContain(1);
    expect(insideRes.results[0].fixtureStats.created).toBeGreaterThan(0);
    expect(insideRes.results[0].gameweekStats.created).toBeGreaterThan(0);

    // 4. Create a user and place a winning prediction on a finished GW1 fixture
    const user = await createUser({ coinBalance: 1000 });
    const finishedGw1Fixture = await db.fixture.findFirstOrThrow({
      where: {
        gameweek: { number: 1 },
        finished: true,
        homeScore: { not: null },
        awayScore: { not: null },
      },
    });
    const winningPick =
      finishedGw1Fixture.homeScore! > finishedGw1Fixture.awayScore!
        ? 'H'
        : finishedGw1Fixture.awayScore! > finishedGw1Fixture.homeScore!
          ? 'A'
          : 'D';

    await db.prediction.create({
      data: {
        userId: user.id,
        fixtureId: finishedGw1Fixture.id,
        pick: winningPick,
        coinsStaked: 100,
        odds: '2.5000',
        resolved: false,
      },
    });

    // Mark only GW1 as dataChecked=true, settledAt=null so runSettleCron settles GW1
    await db.gameweek.updateMany({
      where: { number: { not: 1 } },
      data: { dataChecked: false },
    });
    await db.gameweek.updateMany({
      where: { number: 1 },
      data: { dataChecked: true, settledAt: null },
    });

    const settleTime = new Date('2025-08-18T23:00:00Z');
    const settleRes = await runSettleCron(db, {
      startYear: 2025,
      client,
      fetchLive: true,
      now: settleTime,
    });
    expect(settleRes.settled).toHaveLength(1);
    expect(settleRes.settled[0].gameweek.number).toBe(1);
    expect(settleRes.settled[0].gameweek.alreadySettled).toBe(false);
    expect(settleRes.settled[0].predictions.predictionsResolved).toBe(1);
    expect(settleRes.settled[0].predictions.predictionsWon).toBe(1);
    expect(settleRes.settled[0].predictions.totalPayoutCoins).toBe(250); // 100 * 2.5

    const balanceAfterFirstSettle = await getUserBalanceMinor(db, user.id);
    // Initial 1000 + 250 payout = 1250 coins
    expect(balanceAfterFirstSettle).toBe(1250n * MINOR_UNITS_PER_COIN);

    // 5. Re-settling GW1 (Invariant 3) changes nothing!
    const resettle = await settleGameweek(db, {
      startYear: 2025,
      gameweekNumber: 1,
      client,
      fetchLive: true,
      now: new Date('2025-08-19T01:00:00Z'),
    });
    expect(resettle.gameweek.alreadySettled).toBe(true);
    expect(resettle.liveSync?.fixtureStats.created).toBe(0);
    expect(resettle.liveSync?.fixtureStats.updated).toBe(0);
    expect(resettle.liveSync?.gameweekStats.created).toBe(0);
    expect(resettle.liveSync?.gameweekStats.updated).toBe(0);
    expect(resettle.seasonStats.seasonStats.created).toBe(0);
    expect(resettle.seasonStats.seasonStats.updated).toBe(0);
    expect(resettle.fairValues.fairValuesWritten).toBe(0);
    expect(resettle.fairValues.priceTicksWritten).toBe(0);
    expect(resettle.predictions.predictionsResolved).toBe(0);
    expect(resettle.predictions.totalPayoutCoins).toBe(0);

    const balanceAfterResettle = await getUserBalanceMinor(db, user.id);
    expect(balanceAfterResettle).toBe(balanceAfterFirstSettle);
  });

  it('R6.6 & R7.6: season rollover dry run carries continuing positions, cashes out departed players, preserves 25/26 history, and supports clean rollback', async () => {
    const client = makeMockFplClient();
    await runBootstrapCron(db, { client, forceReprice: true });
    await runFixturesCron(db, { client, startYear: 2025 });

    const user = await createUser({ coinBalance: 10000 });
    const players25 = await db.playerSeason.findMany({
      include: { player: true, asset: true },
      orderBy: { id: 'asc' },
      take: 2,
    });
    const continuingPs = players25[0];
    const departedPs = players25[1];

    // User buys 5 shares of continuingPs and 4 shares of departedPs in 2025/26
    await executeAmmOrder(db, {
      userId: user.id,
      v2AssetId: continuingPs.asset!.id,
      side: 'BUY',
      shares: 5,
    });
    await executeAmmOrder(db, {
      userId: user.id,
      v2AssetId: departedPs.asset!.id,
      side: 'BUY',
      shares: 4,
    });

    const cashBeforeRollover = await getUserBalanceMinor(db, user.id);

    // Construct a 2026/27 preseason bootstrap payload:
    // - events shifted to 2026-08-*
    // - team strengths set to null (preseason reality from R1.1)
    // - element IDs renumbered (+100) while keeping `code` stable
    // - `departedPs` removed from 2026/27 elements (transferred abroad)
    const raw2627 = structuredClone(bootstrapSample) as Record<string, unknown>;
    const events2627 = (raw2627.events as Array<Record<string, unknown>>).map((ev, idx) => ({
      ...ev,
      deadline_time: new Date(Date.UTC(2026, 7, 15 + idx * 7, 17, 30)).toISOString(),
      finished: false,
      data_checked: false,
      is_current: idx === 0,
      is_next: idx === 1,
    }));
    const teams2627 = (raw2627.teams as Array<Record<string, unknown>>).map((t) => ({
      ...t,
      strength: null,
      strength_overall_home: null,
      strength_overall_away: null,
      strength_attack_home: null,
      strength_attack_away: null,
      strength_defence_home: null,
      strength_defence_away: null,
    }));
    const elements2627 = (raw2627.elements as Array<Record<string, unknown>>)
      .filter((el) => el.code !== departedPs.player.fplCode)
      .map((el, idx) => ({
        ...el,
        id: idx + 101, // renumbered FPL element IDs!
      }));

    const bootstrap2627 = parseBootstrapStatic({
      ...raw2627,
      events: events2627,
      teams: teams2627,
      elements: elements2627,
    });

    const rolloverRes = await rolloverSeason(db, {
      fromStartYear: 2025,
      bootstrapPayload: bootstrap2627,
      positionPolicy: 'CARRY_WITH_CASH_OUT_DEPARTED',
      now: new Date('2026-08-08T12:00:00Z'),
    });

    expect(rolloverRes.toStartYear).toBe(2026);
    expect(rolloverRes.verification.previousSeasonFixturesIntact).toBe(true);
    expect(rolloverRes.verification.previousSeasonFairValuesIntact).toBe(true);
    expect(rolloverRes.verification.ledgerReconciled).toBe(true);

    // 1 continuing position carried, 1 departed position cashed out
    expect(rolloverRes.positions.positionsCarried).toBe(1);
    expect(rolloverRes.positions.positionsCashedOut).toBe(1);
    expect(rolloverRes.positions.totalCashOutMinor).toBeGreaterThan(0n);

    // User's cash increased by the exact departed cash-out amount
    const cashAfterRollover = await getUserBalanceMinor(db, user.id);
    expect(cashAfterRollover).toBe(
      cashBeforeRollover + rolloverRes.positions.totalCashOutMinor,
    );

    // Continuing player now has 5 shares in the 2026/27 asset and 0 in the 2025/26 asset
    const newSeason = await db.season.findUniqueOrThrow({ where: { startYear: 2026 } });
    const newContinuingPs = await db.playerSeason.findFirstOrThrow({
      where: { seasonId: newSeason.id, playerId: continuingPs.playerId },
      include: { asset: true },
    });
    const newPos = await db.position.findUniqueOrThrow({
      where: {
        userId_assetId: {
          userId: user.id,
          assetId: newContinuingPs.asset!.id,
        },
      },
    });
    expect(newPos.shares).toBe(5);

    const recon = await reconcileLedger(db);
    expect(recon.ok).toBe(true);

    // Test rollback helper removes 2026/27 while keeping 2025/26 intact
    const rb = await rollbackSeasonRollover(db, { targetStartYear: 2026 });
    expect(rb.deletedSeasonId).toBe(newSeason.id);
    expect(await db.season.findUnique({ where: { startYear: 2026 } })).toBeNull();
    expect(await db.season.findUnique({ where: { startYear: 2025 } })).not.toBeNull();
  });
});
