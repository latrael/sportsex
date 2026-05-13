import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  db,
  cleanDb,
  createUser,
  createPlayer,
  createQuests,
  makeRequest,
} from '../helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/lib/auth';
import { POST } from '@/app/api/onboarding/complete/route';

const mockAuth = vi.mocked(auth);

beforeEach(async () => {
  await cleanDb();
  await createQuests();
  vi.clearAllMocks();
});

describe('POST /api/onboarding/complete', () => {
  it('returns 401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(makeRequest('/api/onboarding/complete', { method: 'POST', body: { playerIds: [1, 2, 3] } }));
    expect(res.status).toBe(401);
  });

  it('grants 500 coins and creates UserQuest on valid 3-player pick', async () => {
    const user = await createUser({ coinBalance: 10000 });
    const [p1, p2, p3] = await Promise.all([createPlayer(), createPlayer(), createPlayer()]);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await POST(makeRequest('/api/onboarding/complete', {
      method: 'POST',
      body: { playerIds: [p1.id, p2.id, p3.id] },
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).coinsGranted).toBe(500);

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.coinBalance).toBe(10500);

    const quest = await db.quest.findUnique({ where: { code: 'onboarding_picks' } });
    const completion = await db.userQuest.findFirst({ where: { userId: user.id, questId: quest!.id } });
    expect(completion).not.toBeNull();
  });

  it('creates a credit transaction', async () => {
    const user = await createUser();
    const [p1, p2, p3] = await Promise.all([createPlayer(), createPlayer(), createPlayer()]);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    await POST(makeRequest('/api/onboarding/complete', {
      method: 'POST',
      body: { playerIds: [p1.id, p2.id, p3.id] },
    }));

    const tx = await db.transaction.findFirst({ where: { userId: user.id, reason: 'onboarding_picks' } });
    expect(tx).not.toBeNull();
    expect(tx?.coinsDelta).toBe(500);
  });

  it('rejects if fewer than 3 players', async () => {
    const user = await createUser();
    const [p1, p2] = await Promise.all([createPlayer(), createPlayer()]);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await POST(makeRequest('/api/onboarding/complete', {
      method: 'POST',
      body: { playerIds: [p1.id, p2.id] },
    }));
    expect(res.status).toBe(400);
  });

  it('rejects if more than 3 players', async () => {
    const user = await createUser();
    const players = await Promise.all([createPlayer(), createPlayer(), createPlayer(), createPlayer()]);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await POST(makeRequest('/api/onboarding/complete', {
      method: 'POST',
      body: { playerIds: players.map((p) => p.id) },
    }));
    expect(res.status).toBe(400);
  });

  it('rejects if any player id does not exist', async () => {
    const user = await createUser();
    const [p1, p2] = await Promise.all([createPlayer(), createPlayer()]);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await POST(makeRequest('/api/onboarding/complete', {
      method: 'POST',
      body: { playerIds: [p1.id, p2.id, 999999] },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_players');
  });

  it('rejects double-completion', async () => {
    const user = await createUser();
    const [p1, p2, p3] = await Promise.all([createPlayer(), createPlayer(), createPlayer()]);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const body = { playerIds: [p1.id, p2.id, p3.id] };
    await POST(makeRequest('/api/onboarding/complete', { method: 'POST', body }));
    const res2 = await POST(makeRequest('/api/onboarding/complete', { method: 'POST', body }));
    expect(res2.status).toBe(409);
    expect((await res2.json()).error).toBe('already_completed');
  });
});
