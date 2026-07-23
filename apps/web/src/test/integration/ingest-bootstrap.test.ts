// The database half of R1.2: planned rows land in the reference tables, and a
// second sync of the same payload writes nothing at all.

import { describe, it, expect, beforeEach } from 'vitest';
import { db, cleanDb } from '../helpers';
import { parseBootstrapStatic } from '@/lib/fpl';
import type { FplBootstrapStatic } from '@/lib/fpl';
import { planBootstrap, syncBootstrap } from '@/lib/ingest';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';

const payload = parseBootstrapStatic(bootstrapSample);
const CLUBS = payload.teams.length; // 4
const PLAYERS = payload.elements.length; // 20
const GAMEWEEKS = payload.events.length; // 3

function mutated(edit: (draft: FplBootstrapStatic) => void): FplBootstrapStatic {
  const draft = structuredClone(payload);
  edit(draft);
  return draft;
}

function sync(source: FplBootstrapStatic = payload) {
  return syncBootstrap(db, planBootstrap(source));
}

beforeEach(async () => {
  await cleanDb();
});

describe('syncBootstrap — first run', () => {
  it('creates the season, clubs, players and gameweeks', async () => {
    const result = await sync();

    expect(result.season).toMatchObject({ name: '2025/26', startYear: 2025, created: true });
    expect(result.clubs).toEqual({ created: CLUBS, updated: 0, unchanged: 0 });
    expect(result.clubSeasons).toEqual({ created: CLUBS, updated: 0, unchanged: 0 });
    expect(result.players).toEqual({ created: PLAYERS, updated: 0, unchanged: 0 });
    expect(result.playerSeasons).toEqual({ created: PLAYERS, updated: 0, unchanged: 0 });
    expect(result.gameweeks).toEqual({ created: GAMEWEEKS, updated: 0, unchanged: 0 });

    expect(await db.club.count()).toBe(CLUBS);
    expect(await db.fplPlayer.count()).toBe(PLAYERS);
    expect(await db.gameweek.count()).toBe(GAMEWEEKS);
  });

  it('wires every player to the right club through real foreign keys', async () => {
    await sync();

    const salah = await db.fplPlayer.findUnique({
      where: { fplCode: 118748 },
      include: { seasons: { include: { clubSeason: { include: { club: true } } } } },
    });

    expect(salah!.optaCode).toBe('p118748');
    expect(salah!.seasons).toHaveLength(1);
    expect(salah!.seasons[0].fplId).toBe(381);
    expect(salah!.seasons[0].position).toBe('MID');
    expect(salah!.seasons[0].clubSeason.club.name).toBe('Liverpool');
    expect(salah!.seasons[0].clubSeason.club.fplCode).toBe(14);
  });

  it('stores the registration and availability fields R1.2 asks for', async () => {
    await sync();

    const petrovic = await db.playerSeason.findFirst({
      where: { fplId: 67 },
      include: { player: true },
    });

    expect(petrovic!.player.birthDate).toEqual(new Date('1999-10-08T00:00:00.000Z'));
    expect(petrovic!.teamJoinDate).toEqual(new Date('2025-07-16T00:00:00.000Z'));
    expect(petrovic!.squadNumber).toBeNull();
    expect(petrovic!.status).toBe('a');
    expect(petrovic!.chanceOfPlayingNextRound).toBeNull();
    expect(petrovic!.selectedByPercent.toString()).toBe(
      payload.elements.find((e) => e.id === 67)!.selected_by_percent,
    );
  });
});

describe('syncBootstrap — re-running', () => {
  it('writes nothing when the payload has not moved (R1.7)', async () => {
    await sync();
    const second = await sync();

    expect(second.season.created).toBe(false);
    expect(second.clubs).toEqual({ created: 0, updated: 0, unchanged: CLUBS });
    expect(second.clubSeasons).toEqual({ created: 0, updated: 0, unchanged: CLUBS });
    expect(second.players).toEqual({ created: 0, updated: 0, unchanged: PLAYERS });
    expect(second.playerSeasons).toEqual({ created: 0, updated: 0, unchanged: PLAYERS });
    expect(second.gameweeks).toEqual({ created: 0, updated: 0, unchanged: GAMEWEEKS });
  });

  it('leaves row ids untouched across a re-run', async () => {
    await sync();
    const before = await db.playerSeason.findMany({ orderBy: { fplId: 'asc' } });
    await sync();
    const after = await db.playerSeason.findMany({ orderBy: { fplId: 'asc' } });

    expect(after).toEqual(before);
  });

  it('updates only the rows that actually changed', async () => {
    await sync();

    const injured = await sync(
      mutated((d) => {
        const element = d.elements.find((e) => e.id === 381)!;
        element.status = 'i';
        element.chance_of_playing_next_round = 25;
        element.news = 'Hamstring injury - 50% chance of playing';
      }),
    );

    expect(injured.players).toEqual({ created: 0, updated: 0, unchanged: PLAYERS });
    expect(injured.playerSeasons).toEqual({ created: 0, updated: 1, unchanged: PLAYERS - 1 });

    const row = await db.playerSeason.findFirst({ where: { fplId: 381 } });
    expect(row!.status).toBe('i');
    expect(row!.chanceOfPlayingNextRound).toBe(25);
  });

  it('separates a name change from a club change', async () => {
    await sync();

    const renamed = await sync(
      mutated((d) => {
        d.elements.find((e) => e.id === 381)!.web_name = 'Mo Salah';
      }),
    );
    expect(renamed.players).toEqual({ created: 0, updated: 1, unchanged: PLAYERS - 1 });
    expect(renamed.playerSeasons).toEqual({ created: 0, updated: 0, unchanged: PLAYERS });
  });

  it('follows a transfer by repointing the club season, not the identity', async () => {
    await sync();
    const before = await db.fplPlayer.findUnique({ where: { fplCode: 118748 } });

    const transferred = await sync(
      mutated((d) => {
        const element = d.elements.find((e) => e.id === 381)!;
        const city = d.teams.find((t) => t.short_name === 'MCI')!;
        element.team = city.id;
        element.team_code = city.code;
      }),
    );

    expect(transferred.players).toEqual({ created: 0, updated: 0, unchanged: PLAYERS });
    expect(transferred.playerSeasons).toEqual({ created: 0, updated: 1, unchanged: PLAYERS - 1 });

    const after = await db.fplPlayer.findUnique({
      where: { fplCode: 118748 },
      include: { seasons: { include: { clubSeason: { include: { club: true } } } } },
    });
    expect(after!.id).toBe(before!.id);
    expect(after!.seasons[0].clubSeason.club.shortName).toBe('MCI');
  });

  it('picks up a gameweek being finalised', async () => {
    await sync(
      mutated((d) => {
        const gw38 = d.events.find((e) => e.id === 38)!;
        gw38.finished = false;
        gw38.data_checked = false;
      }),
    );

    const settled = await sync();
    expect(settled.gameweeks).toEqual({ created: 0, updated: 1, unchanged: GAMEWEEKS - 1 });
    expect((await db.gameweek.findFirst({ where: { number: 38 } }))!.dataChecked).toBe(true);
  });
});

describe('syncBootstrap — across the season rollover', () => {
  /**
   * What early August does to the dataset: FPL renumbers every element and
   * every team, and serves a payload with the same footballers behind entirely
   * different ids. The identity tables have to absorb that without duplicating
   * a single player.
   */
  const nextSeason = () =>
    mutated((d) => {
      for (const team of d.teams) team.id += 50;
      for (const element of d.elements) {
        element.id += 1000;
        element.team += 50;
      }
      for (const event of d.events) {
        event.deadline_time = event.deadline_time!.replace(/^\d{4}/, (year) =>
          String(Number(year) + 1),
        );
      }
    });

  it('reuses the same identities and adds a second season of membership', async () => {
    await sync();
    const result = await sync(nextSeason());

    expect(result.season).toMatchObject({ name: '2026/27', startYear: 2026, created: true });
    expect(result.clubs).toEqual({ created: 0, updated: 0, unchanged: CLUBS });
    expect(result.players).toEqual({ created: 0, updated: 0, unchanged: PLAYERS });
    expect(result.clubSeasons).toEqual({ created: CLUBS, updated: 0, unchanged: 0 });
    expect(result.playerSeasons).toEqual({ created: PLAYERS, updated: 0, unchanged: 0 });

    expect(await db.fplPlayer.count()).toBe(PLAYERS);
    expect(await db.playerSeason.count()).toBe(PLAYERS * 2);
    expect(await db.season.count()).toBe(2);
  });

  it('keeps the old season resolvable after its ids have been reassigned', async () => {
    await sync();
    await sync(nextSeason());

    const seasons = await db.season.findMany({ orderBy: { startYear: 'asc' } });
    const [oldSeason, newSeason] = seasons;

    // element 381 is Salah in 25/26; in 26/27 that id belongs to nobody and
    // Salah answers to 1381. Both still resolve to one footballer.
    const then = await db.playerSeason.findUnique({
      where: { seasonId_fplId: { seasonId: oldSeason.id, fplId: 381 } },
      include: { player: true },
    });
    const now = await db.playerSeason.findUnique({
      where: { seasonId_fplId: { seasonId: newSeason.id, fplId: 1381 } },
      include: { player: true },
    });

    expect(then!.player.fplCode).toBe(118748);
    expect(now!.player.id).toBe(then!.player.id);
    expect(
      await db.playerSeason.findUnique({
        where: { seasonId_fplId: { seasonId: newSeason.id, fplId: 381 } },
      }),
    ).toBeNull();
  });
});
