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
import { POST as claim } from '@/app/api/quests/claim/route';
import { GET as listQuests } from '@/app/api/quests/route';

const mockAuth = vi.mocked(auth);

beforeEach(async () => {
  await cleanDb();
  await createQuests();
  vi.clearAllMocks();
});

describe('POST /api/quests/claim — login_today', () => {
  it('grants coins on first claim', async () => {
    const user = await createUser({ coinBalance: 0 });
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);

    const res = await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'login_today' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.coinsGranted).toBe(100);

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.coinBalance).toBe(100);
  });

  it('creates a transaction record', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'login_today' } }));

    const tx = await db.transaction.findFirst({ where: { userId: user.id, reason: 'quest_login_today' } });
    expect(tx).not.toBeNull();
    expect(tx?.coinsDelta).toBe(100);
  });

  it('rejects double-claim on same day', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);

    await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'login_today' } }));
    const res2 = await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'login_today' } }));
    expect(res2.status).toBe(409);
    expect((await res2.json()).error).toBe('already_claimed_today');
  });
});

describe('POST /api/quests/claim — place_one_trade', () => {
  it('grants reward when user has a trade today', async () => {
    const user = await createUser({ coinBalance: 0 });
    await db.transaction.create({
      data: { userId: user.id, assetKind: 'player', assetId: 1, side: 'buy', shares: 1, price: 10, coinsDelta: -10, reason: 'market_order' },
    });

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'place_one_trade' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).coinsGranted).toBe(200);
  });

  it('rejects when no trade today', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);

    const res = await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'place_one_trade' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no_trade_today');
  });
});

describe('POST /api/quests/claim — comment_on_player', () => {
  it('grants reward when user has a comment today', async () => {
    const user = await createUser({ coinBalance: 0 });
    const player = await createPlayer();
    await db.comment.create({ data: { userId: user.id, playerId: player.id, body: 'great player', status: 'visible' } });

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'comment_on_player' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).coinsGranted).toBe(150);
  });

  it('rejects when no comment today', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);

    const res = await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'comment_on_player' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no_comment_today');
  });
});

describe('POST /api/quests/claim — onboarding_picks', () => {
  it('rejects direct claim (must use onboarding flow)', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'onboarding_picks' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('use_onboarding_flow');
  });
});

describe('POST /api/quests/claim — unknown quest', () => {
  it('returns 404', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'nonexistent_quest' } }));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/quests', () => {
  it('returns all quests with canClaim and completion flags', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);

    const res = await listQuests();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(4);

    const login = body.find((q: { code: string }) => q.code === 'login_today');
    expect(login).toBeDefined();
    expect(login.canClaim).toBe(true);
    expect(login.completedToday).toBe(false);

    const onboarding = body.find((q: { code: string }) => q.code === 'onboarding_picks');
    expect(onboarding.canClaim).toBe(false);
  });

  it('marks login_today as claimed after completing it', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);

    await claim(makeRequest('/api/quests/claim', { method: 'POST', body: { code: 'login_today' } }));

    const res = await listQuests();
    const body = await res.json();
    const login = body.find((q: { code: string }) => q.code === 'login_today');
    expect(login.completedToday).toBe(true);
    expect(login.canClaim).toBe(false);
  });
});
