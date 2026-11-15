import {
  AssetKind,
  FairValueSource,
  PlayerPosition,
  PriceTickSource,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { toLiquidityDecimal, toPriceDecimal } from '@/lib/money';

export const db = new PrismaClient();

let counter = 1;
function nextSeq(): number {
  return counter++;
}

export async function cleanDb() {
  // Delete in dependency order across all v2 + product tables.
  await db.ledgerEntry.deleteMany();
  await db.priceTick.deleteMany();
  await db.trade.deleteMany();
  await db.position.deleteMany();
  await db.fairValue.deleteMany();
  await db.asset.deleteMany();

  await db.userQuest.deleteMany();
  await db.prediction.deleteMany();
  await db.comment.deleteMany();

  await db.rawPayload.deleteMany();
  await db.playerSeasonStat.deleteMany();
  await db.playerFixtureStat.deleteMany();
  await db.playerGameweekStat.deleteMany();
  await db.fixture.deleteMany();
  await db.playerSeason.deleteMany();
  await db.gameweek.deleteMany();
  await db.clubSeason.deleteMany();
  await db.player.deleteMany();
  await db.club.deleteMany();
  await db.season.deleteMany();

  await db.quest.deleteMany();
  await db.privateLeaderboardMember.deleteMany();
  await db.privateLeaderboard.deleteMany();
  await db.friendship.deleteMany();
  await db.user.deleteMany();
}

export async function ensureTestSeason(startYear = 2025) {
  const existing = await db.season.findUnique({ where: { startYear } });
  if (existing) return existing;
  try {
    return await db.season.create({
      data: {
        name: `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`,
        startYear,
      },
    });
  } catch {
    return db.season.findUniqueOrThrow({ where: { startYear } });
  }
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
  const season = await ensureTestSeason();
  const seq = nextSeq();
  const fplCode = 700_000 + seq;
  const clubName = name ?? `Team-${seq}-${Math.random().toString(36).slice(2, 6)}`;
  const club = await db.club.create({
    data: {
      fplCode,
      name: clubName,
      shortName: clubName.slice(0, 3).toUpperCase(),
    },
  });
  const clubSeason = await db.clubSeason.create({
    data: {
      seasonId: season.id,
      clubId: club.id,
      fplId: seq,
      strength: 3,
      strengthOverallHome: 1200,
      strengthOverallAway: 1200,
      strengthAttackHome: 1200,
      strengthAttackAway: 1200,
      strengthDefenceHome: 1200,
      strengthDefenceAway: 1200,
    },
  });
  return {
    ...club,
    clubSeasonId: clubSeason.id,
  };
}

export async function createPlayer(
  clubId?: number,
  overrides?: {
    firstName?: string;
    secondName?: string;
    webName?: string;
    position?: PlayerPosition;
    goals?: number;
    assists?: number;
    minutes?: number;
    cleanSheets?: number;
    saves?: number;
    totalPoints?: number;
  },
) {
  const season = await ensureTestSeason();
  let clubSeason = clubId
    ? (await db.clubSeason.findFirst({ where: { clubId } })) ?? (await db.clubSeason.findUnique({ where: { id: clubId } }))
    : null;
  if (!clubSeason) {
    const team = await createTeam();
    clubSeason = await db.clubSeason.findUnique({ where: { id: team.clubSeasonId } });
  }

  const seq = nextSeq();
  const fplCode = 800_000 + seq;
  const firstName = overrides?.firstName ?? 'Player';
  const secondName = overrides?.secondName ?? `${seq}-${Math.random().toString(36).slice(2, 6)}`;
  const webName = overrides?.webName ?? secondName;

  const player = await db.player.create({
    data: {
      fplCode,
      optaCode: `p${fplCode}`,
      firstName,
      secondName,
      webName,
    },
  });

  const ps = await db.playerSeason.create({
    data: {
      seasonId: season.id,
      playerId: player.id,
      clubSeasonId: clubSeason!.id,
      fplId: seq,
      position: overrides?.position ?? PlayerPosition.FWD,
      status: 'a',
      news: '',
      nowCost: 60,
      selectedByPercent: new Prisma.Decimal('5.000'),
    },
  });

  await db.playerSeasonStat.create({
    data: {
      playerSeasonId: ps.id,
      appearances: 10,
      minutes: overrides?.minutes ?? 900,
      starts: 10,
      goalsScored: overrides?.goals ?? 5,
      assists: overrides?.assists ?? 3,
      cleanSheets: overrides?.cleanSheets ?? 2,
      goalsConceded: 8,
      ownGoals: 0,
      penaltiesSaved: 0,
      penaltiesMissed: 0,
      yellowCards: 1,
      redCards: 0,
      saves: overrides?.saves ?? 0,
      bonus: 4,
      defensiveContribution: 10,
      totalPoints: overrides?.totalPoints ?? 55,
      bps: 180,
      tackles: 12,
      recoveries: 20,
      clearancesBlocksInterceptions: 15,
      influence: new Prisma.Decimal('200.00'),
      creativity: new Prisma.Decimal('150.00'),
      threat: new Prisma.Decimal('250.00'),
      ictIndex: new Prisma.Decimal('60.00'),
      expectedGoals: new Prisma.Decimal('4.50'),
      expectedAssists: new Prisma.Decimal('2.50'),
      expectedGoalInvolvements: new Prisma.Decimal('7.00'),
      expectedGoalsConceded: new Prisma.Decimal('8.00'),
    },
  });

  return {
    ...player,
    fullName: `${firstName} ${secondName}`.trim(),
    playerSeasonId: ps.id,
    clubSeasonId: clubSeason!.id,
  };
}

export async function createValuation(playerId: number, price = 100) {
  const ps = (await db.playerSeason.findFirst({ where: { playerId } })) ?? (await db.playerSeason.findUnique({ where: { id: playerId } }));
  if (!ps) throw new Error(`PlayerSeason not found for playerId=${playerId}`);

  const asset = await db.asset.upsert({
    where: { playerSeasonId: ps.id },
    update: {},
    create: {
      kind: AssetKind.PLAYER,
      playerSeasonId: ps.id,
      inventory: 0,
      seedInventory: 0,
      liquidity: toLiquidityDecimal(2000),
    },
  });

  const dec = toPriceDecimal(price);
  await db.fairValue.create({
    data: {
      assetId: asset.id,
      source: FairValueSource.SEED,
      value: dec,
    },
  });

  return db.priceTick.create({
    data: {
      assetId: asset.id,
      source: PriceTickSource.VALUATION,
      price: dec,
      fairValue: dec,
      inventory: asset.inventory,
    },
  });
}

export async function createTeamValuation(teamId: number, price = 200) {
  const cs = (await db.clubSeason.findFirst({ where: { clubId: teamId } })) ?? (await db.clubSeason.findUnique({ where: { id: teamId } }));
  if (!cs) throw new Error(`ClubSeason not found for teamId=${teamId}`);

  const asset = await db.asset.upsert({
    where: { clubSeasonId: cs.id },
    update: {},
    create: {
      kind: AssetKind.CLUB,
      clubSeasonId: cs.id,
      inventory: 0,
      seedInventory: 0,
      liquidity: toLiquidityDecimal(800),
    },
  });

  const dec = toPriceDecimal(price);
  await db.fairValue.create({
    data: {
      assetId: asset.id,
      source: FairValueSource.SEED,
      value: dec,
    },
  });

  return db.priceTick.create({
    data: {
      assetId: asset.id,
      source: PriceTickSource.VALUATION,
      price: dec,
      fairValue: dec,
      inventory: asset.inventory,
    },
  });
}

export async function createScheduledMatch(
  homeTeamId: number,
  awayTeamId: number,
  opts?: { finished?: boolean; homeScore?: number; awayScore?: number },
) {
  const season = await ensureTestSeason();
  const homeCs = await db.clubSeason.findFirst({
    where: { OR: [{ clubId: homeTeamId }, { id: homeTeamId }] },
  });
  const awayCs = await db.clubSeason.findFirst({
    where: { OR: [{ clubId: awayTeamId }, { id: awayTeamId }] },
  });
  if (!homeCs || !awayCs) {
    throw new Error('Home or away ClubSeason not found');
  }

  const kickoffTime = new Date();
  kickoffTime.setDate(kickoffTime.getDate() + 3);
  const seq = nextSeq();

  return db.fixture.create({
    data: {
      seasonId: season.id,
      fplId: seq,
      code: 900_000 + seq,
      homeClubSeasonId: homeCs.id,
      awayClubSeasonId: awayCs.id,
      kickoffTime,
      started: opts?.finished ?? false,
      finished: opts?.finished ?? false,
      finishedProvisional: opts?.finished ?? false,
      provisionalStartTime: false,
      minutes: opts?.finished ? 90 : 0,
      homeScore: opts?.homeScore ?? null,
      awayScore: opts?.awayScore ?? null,
      homeDifficulty: 3,
      awayDifficulty: 3,
    },
  });
}

export async function createQuests() {
  await db.quest.createMany({
    data: [
      {
        code: 'login_today',
        title: 'Daily Login',
        body: 'Sign in today.',
        rewardCoins: 100,
        repeatKind: 'daily',
      },
      {
        code: 'place_one_trade',
        title: 'Make a Move',
        body: 'Place a trade today.',
        rewardCoins: 200,
        repeatKind: 'daily',
      },
      {
        code: 'comment_on_player',
        title: 'Hot Take',
        body: 'Post a comment.',
        rewardCoins: 150,
        repeatKind: 'daily',
      },
      {
        code: 'onboarding_picks',
        title: 'First Picks',
        body: 'Pick 3 players.',
        rewardCoins: 500,
        repeatKind: 'one_shot',
      },
    ],
  });
}

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
