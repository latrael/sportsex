import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  db,
  cleanDb,
  createUser,
  createTeam,
  createPlayer,
  createValuation,
  createScheduledMatch,
  makeRequest,
} from '../helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { POST } from '@/app/api/admin/simulate-match/route';

const ADMIN_HEADERS = { 'x-admin-token': 'test-admin-token' };

beforeEach(async () => {
  await cleanDb();
  vi.clearAllMocks();
});

async function buildTeamWithPlayers() {
  const team = await createTeam();
  const players = await Promise.all(
    Array.from({ length: 5 }, () => createPlayer(team.id)),
  );
  await Promise.all(players.map((p) => createValuation(p.id, 100)));
  return { team, players };
}

describe('POST /api/admin/simulate-match', () => {
  it('returns 401 without admin token', async () => {
    const req = makeRequest('/api/admin/simulate-match', { method: 'POST', body: { homeTeamId: 1, awayTeamId: 2, homeScore: 1, awayScore: 0 } });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('creates a settled match and updates player valuations', async () => {
    const { team: home } = await buildTeamWithPlayers();
    const { team: away } = await buildTeamWithPlayers();

    const req = makeRequest('/api/admin/simulate-match', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { homeTeamId: home.id, awayTeamId: away.id, homeScore: 2, awayScore: 1 },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.priceChanges).toBeGreaterThan(0);

    const match = await db.match.findUnique({ where: { id: body.matchId } });
    expect(match?.status).toBe('settled');
    expect(match?.homeScore).toBe(2);
    expect(match?.awayScore).toBe(1);
    expect(match?.settledAt).not.toBeNull();
  });

  it('rejects homeTeamId === awayTeamId', async () => {
    const { team } = await buildTeamWithPlayers();
    const req = makeRequest('/api/admin/simulate-match', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { homeTeamId: team.id, awayTeamId: team.id, homeScore: 1, awayScore: 0 },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('same_team');
  });

  it('settles an existing scheduled match by matchId', async () => {
    const { team: home } = await buildTeamWithPlayers();
    const { team: away } = await buildTeamWithPlayers();
    const scheduled = await createScheduledMatch(home.id, away.id);

    const req = makeRequest('/api/admin/simulate-match', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { matchId: scheduled.id, homeScore: 3, awayScore: 0 },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const updated = await db.match.findUnique({ where: { id: scheduled.id } });
    expect(updated?.status).toBe('settled');
    expect(updated?.homeScore).toBe(3);
  });

  it('rejects settling an already-settled match', async () => {
    const { team: home } = await buildTeamWithPlayers();
    const { team: away } = await buildTeamWithPlayers();
    const match = await db.match.create({
      data: { homeTeamId: home.id, awayTeamId: away.id, kickoffAt: new Date(), status: 'settled', homeScore: 1, awayScore: 0, settledAt: new Date() },
    });

    const req = makeRequest('/api/admin/simulate-match', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { matchId: match.id, homeScore: 2, awayScore: 1 },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('already_settled');
  });

  it('resolves pending predictions after settle', async () => {
    const { team: home } = await buildTeamWithPlayers();
    const { team: away } = await buildTeamWithPlayers();
    const scheduled = await createScheduledMatch(home.id, away.id);

    const user = await createUser({ coinBalance: 1000 });
    // User stakes on home win (H) — home wins 2-0 so this should pay out
    await db.prediction.create({ data: { userId: user.id, matchId: scheduled.id, pick: 'H', coinsStaked: 100 } });

    const req = makeRequest('/api/admin/simulate-match', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { matchId: scheduled.id, homeScore: 2, awayScore: 0 },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedPredictions).toBe(1);

    const pred = await db.prediction.findFirst({ where: { userId: user.id, matchId: scheduled.id } });
    expect(pred?.resolved).toBe(true);
    expect(pred?.payout).toBe(200); // 2× stake

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.coinBalance).toBe(1200); // 1000 + 200 payout
  });

  it('gives zero payout on losing prediction', async () => {
    const { team: home } = await buildTeamWithPlayers();
    const { team: away } = await buildTeamWithPlayers();
    const scheduled = await createScheduledMatch(home.id, away.id);

    const user = await createUser({ coinBalance: 500 });
    // User stakes on away win (A) — home wins so this should pay zero
    await db.prediction.create({ data: { userId: user.id, matchId: scheduled.id, pick: 'A', coinsStaked: 100 } });

    const req = makeRequest('/api/admin/simulate-match', {
      method: 'POST',
      headers: ADMIN_HEADERS,
      body: { matchId: scheduled.id, homeScore: 1, awayScore: 0 },
    });
    await POST(req);

    const pred = await db.prediction.findFirst({ where: { userId: user.id } });
    expect(pred?.resolved).toBe(true);
    expect(pred?.payout).toBe(0);

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.coinBalance).toBe(500); // unchanged
  });
});
