import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  db,
  cleanDb,
  createUser,
  createTeam,
  createScheduledMatch,
  makeRequest,
} from '../helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/lib/auth';
import { POST, GET } from '@/app/api/predictions/route';

const mockAuth = vi.mocked(auth);

beforeEach(async () => {
  await cleanDb();
  vi.clearAllMocks();
});

describe('POST /api/predictions', () => {
  it('returns 401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null as never);
    const req = makeRequest('/api/predictions', {
      method: 'POST',
      body: { matchId: 1, pick: 'H', coinsStaked: 100 },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('places a prediction, deducts coins, creates record', async () => {
    const user = await createUser({ coinBalance: 1000 });
    const home = await createTeam();
    const away = await createTeam();
    const match = await createScheduledMatch(home.id, away.id);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/predictions', {
      method: 'POST',
      body: { matchId: match.id, pick: 'H', coinsStaked: 200 },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.pick).toBe('H');

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.coinBalance).toBe(800);

    const pred = await db.prediction.findFirst({ where: { userId: user.id, matchId: match.id } });
    expect(pred).not.toBeNull();
    expect(pred?.coinsStaked).toBe(200);
    expect(pred?.resolved).toBe(false);
  });

  it('rejects duplicate prediction for same match', async () => {
    const user = await createUser({ coinBalance: 2000 });
    const home = await createTeam();
    const away = await createTeam();
    const match = await createScheduledMatch(home.id, away.id);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const first = makeRequest('/api/predictions', { method: 'POST', body: { matchId: match.id, pick: 'H', coinsStaked: 100 } });
    await POST(first);

    const second = makeRequest('/api/predictions', { method: 'POST', body: { matchId: match.id, pick: 'A', coinsStaked: 100 } });
    const res = await POST(second);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_predicted');
  });

  it('rejects when match not found', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/predictions', { method: 'POST', body: { matchId: 99999, pick: 'D', coinsStaked: 100 } });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it('rejects when match is already settled', async () => {
    const user = await createUser({ coinBalance: 1000 });
    const home = await createTeam();
    const away = await createTeam();
    const match = await db.match.create({
      data: { homeTeamId: home.id, awayTeamId: away.id, kickoffAt: new Date(), status: 'settled' },
    });

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/predictions', { method: 'POST', body: { matchId: match.id, pick: 'H', coinsStaked: 100 } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('match_not_open');
  });

  it('rejects when insufficient funds', async () => {
    const user = await createUser({ coinBalance: 50 });
    const home = await createTeam();
    const away = await createTeam();
    const match = await createScheduledMatch(home.id, away.id);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/predictions', { method: 'POST', body: { matchId: match.id, pick: 'D', coinsStaked: 100 } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('insufficient_funds');
  });

  it('rejects stake below minimum (10 coins)', async () => {
    const user = await createUser();
    const home = await createTeam();
    const away = await createTeam();
    const match = await createScheduledMatch(home.id, away.id);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/predictions', { method: 'POST', body: { matchId: match.id, pick: 'H', coinsStaked: 5 } });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/predictions', () => {
  it('returns user predictions with match details', async () => {
    const user = await createUser({ coinBalance: 2000 });
    const home = await createTeam();
    const away = await createTeam();
    const match = await createScheduledMatch(home.id, away.id);

    await db.prediction.create({
      data: { userId: user.id, matchId: match.id, pick: 'H', coinsStaked: 100 },
    });

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/predictions');
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].pick).toBe('H');
    expect(body[0].match.home.name).toBe(home.name);
  });
});
