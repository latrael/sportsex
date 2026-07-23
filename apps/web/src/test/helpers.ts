import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Use the same client the app uses so module-level singletons stay consistent.
// DATABASE_URL is set to test.db in vitest.config.ts env before any import.
export const db = new PrismaClient();

export async function cleanDb() {
  // Delete in dependency order.
  // Schema v2 reference tables (Phase 1) first — nothing joins them to v1.
  await db.playerSeason.deleteMany();
  await db.gameweek.deleteMany();
  await db.clubSeason.deleteMany();
  await db.fplPlayer.deleteMany();
  await db.club.deleteMany();
  await db.season.deleteMany();

  await db.userQuest.deleteMany();
  await db.prediction.deleteMany();
  await db.comment.deleteMany();
  await db.transaction.deleteMany();
  await db.holding.deleteMany();
  await db.order.deleteMany();
  await db.valuation.deleteMany();
  await db.playerMatchStat.deleteMany();
  await db.match.deleteMany();
  await db.player.deleteMany();
  await db.team.deleteMany();
  await db.quest.deleteMany();
  await db.privateLeaderboardMember.deleteMany();
  await db.privateLeaderboard.deleteMany();
  await db.friendship.deleteMany();
  await db.user.deleteMany();
}

export async function createUser(overrides?: {
  email?: string;
  handle?: string;
  coinBalance?: number;
}) {
  const hash = await bcrypt.hash('password123', 4);
  return db.user.create({
    data: {
      email: overrides?.email ?? `user-${Math.random().toString(36).slice(2)}@test.com`,
      handle: overrides?.handle ?? `user-${Math.random().toString(36).slice(2)}`,
      passwordHash: hash,
      coinBalance: overrides?.coinBalance ?? 10000,
    },
  });
}

export async function createTeam(name?: string) {
  return db.team.create({
    data: { name: name ?? `Team-${Math.random().toString(36).slice(2)}` },
  });
}

export async function createPlayer(teamId?: number) {
  return db.player.create({
    data: {
      playerKey: `player-${Math.random().toString(36).slice(2)}`,
      fullName: `Player ${Math.random().toString(36).slice(2)}`,
      teamId: teamId ?? null,
      position: 'FWD',
      posBucket: 'FWD',
      goals: 5,
      assists: 3,
      minutes: 900,
      totalShares: 10000,
      sharesHeld: 0,
    },
  });
}

export async function createValuation(playerId: number, price = 100) {
  return db.valuation.create({
    data: { playerId, price, basePrice: price, demandMult: 1.0 },
  });
}

export async function createTeamValuation(teamId: number, price = 200) {
  return db.valuation.create({
    data: { teamId, price, basePrice: price, demandMult: 1.0 },
  });
}

export async function createScheduledMatch(homeTeamId: number, awayTeamId: number) {
  const kickoffAt = new Date();
  kickoffAt.setDate(kickoffAt.getDate() + 3);
  return db.match.create({
    data: { homeTeamId, awayTeamId, kickoffAt, status: 'scheduled' },
  });
}

export async function createQuests() {
  await db.quest.createMany({
    data: [
      { code: 'login_today', title: 'Daily Login', body: 'Sign in today.', rewardCoins: 100, repeatKind: 'daily' },
      { code: 'place_one_trade', title: 'Make a Move', body: 'Place a trade today.', rewardCoins: 200, repeatKind: 'daily' },
      { code: 'comment_on_player', title: 'Hot Take', body: 'Post a comment.', rewardCoins: 150, repeatKind: 'daily' },
      { code: 'onboarding_picks', title: 'First Picks', body: 'Pick 3 players.', rewardCoins: 500, repeatKind: 'one_shot' },
    ],
  });
}

// Build a minimal Request for calling route handlers directly.
export function makeRequest(
  url: string,
  opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
) {
  return new Request(`http://localhost${url}`, {
    method: opts?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    body: opts?.body != null ? JSON.stringify(opts.body) : undefined,
  });
}
