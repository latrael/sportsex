import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  db,
  cleanDb,
  createUser,
  createTeam,
  createPlayer,
  createValuation,
  createTeamValuation,
  makeRequest,
} from '../helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/lib/auth';
import { lastOrderAt } from '@/lib/cooldown';
import { POST } from '@/app/api/orders/route';
import { reconcileLedger } from '@/lib/market';

const mockAuth = vi.mocked(auth);

beforeEach(async () => {
  await cleanDb();
  lastOrderAt.clear();
  vi.clearAllMocks();
});

async function buy(userId: string, playerId: number, shares = 1) {
  mockAuth.mockResolvedValue({ user: { id: userId } } as never);
  const req = makeRequest('/api/orders', {
    method: 'POST',
    body: { assetKind: 'player', assetId: playerId, side: 'buy', shares },
  });
  return POST(req);
}

describe('POST /api/orders — buy player (AMM + ledger)', () => {
  it('returns 401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null as never);
    const req = makeRequest('/api/orders', {
      method: 'POST',
      body: { assetKind: 'player', assetId: 1, side: 'buy', shares: 1 },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('buys shares on the bonding curve, records double-entry ledger, and upserts position', async () => {
    const user = await createUser({ coinBalance: 10000 });
    const player = await createPlayer();
    await createValuation(player.id, 100);

    const res = await buy(user.id, player.id, 5);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // 5 shares at V=100, L=2000: integral ≈ 500.63 coins + 0.5% fee (~2.50 coins) -> -503 whole coins
    expect(body.coinsDelta).toBeLessThan(-500);
    expect(body.coinsDelta).toBeGreaterThan(-510);

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.coinBalance).toBe(10000 + body.coinsDelta);

    const holding = await db.holding.findFirst({ where: { userId: user.id, assetId: player.id } });
    expect(holding?.shares).toBe(5);
    expect(holding?.avgCost).toBeGreaterThan(100);

    const position = await db.position.findFirst({ where: { userId: user.id } });
    expect(position?.shares).toBe(5);

    const recon = await reconcileLedger(db);
    expect(recon.ok).toBe(true);
  });

  it('creates a price_tick and valuation tick after the fill', async () => {
    const user = await createUser();
    const player = await createPlayer();
    await createValuation(player.id, 100);

    const before = await db.valuation.count({ where: { playerId: player.id } });
    await buy(user.id, player.id, 1);
    const after = await db.valuation.count({ where: { playerId: player.id } });

    expect(after).toBe(before + 1);
    expect(await db.priceTick.count()).toBe(1);
    expect(await db.trade.count()).toBe(1);
  });

  it('rejects buy when insufficient funds', async () => {
    const user = await createUser({ coinBalance: 50 });
    const player = await createPlayer();
    await createValuation(player.id, 100);

    const res = await buy(user.id, player.id, 5); // costs >500
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('insufficient_funds');
  });

  it('enforces 5% float cap per order', async () => {
    const user = await createUser({ coinBalance: 9999999 });
    const player = await createPlayer();
    await createValuation(player.id, 1);

    // 5% of 10000 total shares = 500; ordering 501 should fail
    const res = await buy(user.id, player.id, 501);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('max_float_pct');
  });

  it('enforces cooldown between orders', async () => {
    const user = await createUser();
    const player = await createPlayer();
    await createValuation(player.id, 10);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req1 = makeRequest('/api/orders', { method: 'POST', body: { assetKind: 'player', assetId: player.id, side: 'buy', shares: 1 } });
    await POST(req1);

    // Second immediate order should be rate-limited
    const req2 = makeRequest('/api/orders', { method: 'POST', body: { assetKind: 'player', assetId: player.id, side: 'buy', shares: 1 } });
    const res2 = await POST(req2);
    expect(res2.status).toBe(429);
    expect((await res2.json()).error).toBe('cooldown');
  });
});

describe('POST /api/orders — sell player', () => {
  it('sells shares and credits ledger balance', async () => {
    const user = await createUser({ coinBalance: 5000 });
    const player = await createPlayer();
    await createValuation(player.id, 100);

    // Seed a holding directly
    await db.holding.create({ data: { userId: user.id, assetKind: 'player', assetId: player.id, shares: 10, avgCost: 80 } });

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/orders', { method: 'POST', body: { assetKind: 'player', assetId: player.id, side: 'sell', shares: 5 } });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.coinsDelta).toBeGreaterThan(490);
    expect(body.coinsDelta).toBeLessThanOrEqual(500);

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.coinBalance).toBe(5000 + body.coinsDelta);

    const holding = await db.holding.findFirst({ where: { userId: user.id, assetId: player.id } });
    expect(holding?.shares).toBe(5);
  });

  it('removes holding when all shares sold', async () => {
    const user = await createUser();
    const player = await createPlayer();
    await createValuation(player.id, 50);
    await db.holding.create({ data: { userId: user.id, assetKind: 'player', assetId: player.id, shares: 3, avgCost: 50 } });

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/orders', { method: 'POST', body: { assetKind: 'player', assetId: player.id, side: 'sell', shares: 3 } });
    await POST(req);

    const holding = await db.holding.findFirst({ where: { userId: user.id, assetId: player.id } });
    expect(holding).toBeNull();
    expect(await db.position.findFirst({ where: { userId: user.id } })).toBeNull();
  });

  it('rejects sell when no holding', async () => {
    const user = await createUser();
    const player = await createPlayer();
    await createValuation(player.id, 50);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/orders', { method: 'POST', body: { assetKind: 'player', assetId: player.id, side: 'sell', shares: 1 } });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('insufficient_shares');
  });
});

describe('POST /api/orders — Invariant 1 & §2 exploit prevention', () => {
  it('buy then immediate sell loses exactly the two fees (zero round-trip profit)', async () => {
    const user = await createUser({ coinBalance: 10000 });
    const player = await createPlayer();
    await createValuation(player.id, 100);

    // Buy 10 shares
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const buyReq = makeRequest('/api/orders', { method: 'POST', body: { assetKind: 'player', assetId: player.id, side: 'buy', shares: 10 } });
    const buyRes = await POST(buyReq);
    const buyBody = await buyRes.json();

    // Bypass cooldown
    lastOrderAt.delete(user.id);

    // Sell the same 10 shares immediately
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const sellReq = makeRequest('/api/orders', { method: 'POST', body: { assetKind: 'player', assetId: player.id, side: 'sell', shares: 10 } });
    const sellRes = await POST(sellReq);
    const sellBody = await sellRes.json();

    // Gross curve integral on buy and sell are identical; net loss in minor units is exactly buyFee + sellFee
    expect(buyBody.grossCostMinor).toBe(sellBody.grossCostMinor);
    const netMinorDelta = BigInt(buyBody.coinsDeltaMinor) + BigInt(sellBody.coinsDeltaMinor);
    const totalFeesMinor = BigInt(buyBody.feeMinor) + BigInt(sellBody.feeMinor);
    expect(netMinorDelta).toBe(-totalFeesMinor);
    expect(BigInt(sellBody.balanceMinor)).toBe(1_000_000n - totalFeesMinor);
  });
});

describe('POST /api/orders — buy team', () => {
  it('buys team shares', async () => {
    const user = await createUser({ coinBalance: 10000 });
    const team = await createTeam();
    await createTeamValuation(team.id, 200);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const req = makeRequest('/api/orders', { method: 'POST', body: { assetKind: 'team', assetId: team.id, side: 'buy', shares: 2 } });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const holding = await db.holding.findFirst({ where: { userId: user.id, assetId: team.id, assetKind: 'team' } });
    expect(holding?.shares).toBe(2);
  });
});
