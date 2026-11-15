import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LedgerAccount, LedgerReason } from '@prisma/client';
import {
  db,
  cleanDb,
  createUser,
  createPlayer,
  createValuation,
  createQuests,
  makeRequest,
} from '../helpers';
import { parseBootstrapStatic, parseEventLive, parseFixtures } from '@/lib/fpl';
import {
  planBootstrap,
  planEventLive,
  planFixtures,
  syncBootstrap,
  syncEventLive,
  syncFixtures,
} from '@/lib/ingest';
import { recomputeSeasonStats } from '@/lib/derive/seasonStats/sync';
import { runDailyReconciliation } from '@/lib/reconcile';
import { clearCapturedAlerts, getCapturedAlerts } from '@/lib/observability';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';
import gw1Sample from '../fixtures/fpl/event-1-live.sample.json';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/lib/auth';
import { POST as claimQuest } from '@/app/api/quests/claim/route';
import { POST as completeOnboarding } from '@/app/api/onboarding/complete/route';

const mockAuth = vi.mocked(auth);

beforeEach(async () => {
  await cleanDb();
  clearCapturedAlerts();
  vi.clearAllMocks();
});

describe('R7.2 — Quest Verification and Starter Position Checks', () => {
  it('login_today rejects stale sessions with no login today and succeeds when logged in today', async () => {
    await createQuests();
    const user = await createUser({ coinBalance: 1000 });
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    await db.user.update({
      where: { id: user.id },
      data: { createdAt: twoDaysAgo, lastLoginAt: twoDaysAgo },
    });

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const rejected = await claimQuest(
      makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'login_today' } }),
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe('no_login_today');

    // Simulate active login today
    await db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    const accepted = await claimQuest(
      makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'login_today' } }),
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).coinsGranted).toBe(100);
  });

  it('onboarding_picks rejects when priced assets are not held, and succeeds when buyStarterShares=true buys 1 share of each', async () => {
    await createQuests();
    const user = await createUser({ coinBalance: 10000 });
    const [p1, p2, p3] = await Promise.all([createPlayer(), createPlayer(), createPlayer()]);
    await Promise.all([
      createValuation(p1.id, 150),
      createValuation(p2.id, 160),
      createValuation(p3.id, 170),
    ]);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);

    // Calling without holding shares and without buyStarterShares -> 400 positions_not_held
    const rejected = await completeOnboarding(
      makeRequest('/api/onboarding/complete', {
        method: 'POST',
        body: { playerIds: [p1.id, p2.id, p3.id] },
      }),
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe('positions_not_held');

    // Calling with buyStarterShares: true purchases 1 share in each of the 3 players and grants 500 coins
    const accepted = await completeOnboarding(
      makeRequest('/api/onboarding/complete', {
        method: 'POST',
        body: { playerIds: [p1.id, p2.id, p3.id], buyStarterShares: true },
      }),
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).coinsGranted).toBe(500);

    const positions = await db.position.findMany({
      where: { userId: user.id, shares: { gt: 0 } },
    });
    expect(positions).toHaveLength(3);
  });
});

describe('R7.4 & R7.5 — Daily Reconciliation Job & Sentry/Alerting on Invariant 2 & 4 Drift', () => {
  it('passes on clean state and fires alerts when either Invariant 4 (season stats) or Invariant 2 (ledger) is corrupted', async () => {
    await syncBootstrap(db, planBootstrap(parseBootstrapStatic(bootstrapSample)));
    await syncFixtures(db, planFixtures(parseFixtures(fixturesSample)), { startYear: 2025 });
    await syncEventLive(db, planEventLive(parseEventLive(gw1Sample)), {
      startYear: 2025,
      gameweekNumber: 1,
    });
    await recomputeSeasonStats(db, { startYear: 2025 });

    // 1. Clean state -> ok: true, 0 alerts
    const cleanRes = await runDailyReconciliation(db);
    expect(cleanRes.ok).toBe(true);
    expect(cleanRes.invariant2.ok).toBe(true);
    expect(cleanRes.invariant4.ok).toBe(true);
    expect(cleanRes.alertsFired).toHaveLength(0);

    // 2. Corrupt a player_season_stat row -> Invariant 4 fails and fires critical alert
    const targetStat = await db.playerSeasonStat.findFirstOrThrow({
      orderBy: { id: 'asc' },
    });
    await db.playerSeasonStat.update({
      where: { id: targetStat.id },
      data: { goalsScored: targetStat.goalsScored + 42 },
    });

    const sentEnvelopes: string[] = [];
    const prevDsn = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'https://publickey123@sentry.test/456';

    try {
      const driftedStatRes = await runDailyReconciliation(db, {
        fetchImpl: async (input) => {
          sentEnvelopes.push(typeof input === 'string' ? input : input.toString());
          return new Response('{}', { status: 200 });
        },
      });

      expect(driftedStatRes.ok).toBe(false);
      expect(driftedStatRes.invariant4.ok).toBe(false);
      expect(driftedStatRes.invariant4.driftedBySeason[2025]).toContain(
        targetStat.playerSeasonId,
      );
      expect(driftedStatRes.alertsFired).toHaveLength(1);
      expect(driftedStatRes.alertsFired[0].source).toBe('reconcile:invariant4');
      expect(sentEnvelopes).toContain('https://sentry.test/api/456/store/');

      // Repair season stats
      await recomputeSeasonStats(db, { startYear: 2025 });

      // 3. Corrupt a ledger_entry row -> Invariant 2 fails and fires critical alert
      const user = await createUser({ coinBalance: 1000 });
      await db.ledgerEntry.create({
        data: {
          userId: user.id,
          account: LedgerAccount.USER_CASH,
          reason: LedgerReason.COIN_GRANT,
          amount: 50_000n, // unbalanced single leg!
          transferId: 'corrupted-transfer-id',
        },
      });

      const driftedLedgerRes = await runDailyReconciliation(db);
      expect(driftedLedgerRes.ok).toBe(false);
      expect(driftedLedgerRes.invariant2.ok).toBe(false);
      expect(
        driftedLedgerRes.alertsFired.some((a) => a.source === 'reconcile:invariant2'),
      ).toBe(true);
      expect(getCapturedAlerts().length).toBeGreaterThanOrEqual(2);
    } finally {
      process.env.SENTRY_DSN = prevDsn;
    }
  });
});
