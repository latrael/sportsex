// bootstrap-static → the reference tables, as a pure function.
//
// Planning is separate from writing for the same reason parsing is separate
// from fetching (see lib/fpl/parse.ts): the whole transformation is testable
// against a checked-in payload with no database in sight, and a payload
// archived today can be re-planned by tomorrow's code.
//
// Everything here is keyed on FPL's stable identifiers. No lookup in this file
// goes through a player or club name.
//
// The identity key is `element.code` alone. R1.2 was specified as `fpl_id` +
// `opta_code`, but a live run showed `opta_code` is literally "p" + `code` for
// all 841 players in 25/26, so it adds no independent evidence. It is stored
// and kept unique regardless — it is the join key into other providers' Opta
// data, which R1.6's independent cross-check needs.

import type { Position } from '@prisma/client';
import type { FplBootstrapStatic, FplElement, FplEvent, FplTeam } from '@/lib/fpl';

export type SeasonPlan = {
  /** "2025/26" */
  name: string;
  startYear: number;
};

export type PlannedClub = {
  identity: {
    fplCode: number;
    pulseId: number | null;
    name: string;
    shortName: string;
  };
  season: {
    fplId: number;
    strength: number;
    strengthOverallHome: number;
    strengthOverallAway: number;
    strengthAttackHome: number;
    strengthAttackAway: number;
    strengthDefenceHome: number;
    strengthDefenceAway: number;
  };
};

export type PlannedPlayer = {
  identity: {
    fplCode: number;
    optaCode: string | null;
    firstName: string;
    secondName: string;
    webName: string;
    birthDate: Date | null;
  };
  /** The club's stable code, not its season-scoped id — sync resolves it. */
  clubFplCode: number;
  season: {
    fplId: number;
    position: Position;
    status: string;
    chanceOfPlayingThisRound: number | null;
    chanceOfPlayingNextRound: number | null;
    news: string;
    newsAddedAt: Date | null;
    squadNumber: number | null;
    teamJoinDate: Date | null;
    nowCost: number;
    /** Left as the string the wire carried, for the Decimal column. */
    selectedByPercent: string;
  };
};

export type PlannedGameweek = {
  number: number;
  name: string;
  deadlineTime: Date | null;
  finished: boolean;
  dataChecked: boolean;
  isPrevious: boolean;
  isCurrent: boolean;
  isNext: boolean;
  averageEntryScore: number | null;
  highestScore: number | null;
};

export type BootstrapPlan = {
  season: SeasonPlan;
  clubs: PlannedClub[];
  players: PlannedPlayer[];
  gameweeks: PlannedGameweek[];
  /**
   * Oddities that don't threaten integrity. The split matters operationally: a
   * hard failure stops the daily cron, so only things that would corrupt the
   * data or break a unique constraint get to do that. A single player with a
   * momentarily inconsistent `team_code` mid-transfer must not take the ingest
   * down with it.
   */
  warnings: string[];
};

/**
 * Thrown when a payload is well-formed JSON of the right shape but internally
 * inconsistent — an element pointing at a team that isn't in the file, two
 * players sharing an `opta_code`, a date FPL wrote in a format it has never
 * used before. These are integrity failures, so they stop the ingest rather
 * than being written and discovered later as bad history.
 */
export class BootstrapPlanError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    const shown = issues.slice(0, 5).join('; ');
    const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
    super(`bootstrap-static payload is not internally consistent — ${shown}${more}`);
    this.name = 'BootstrapPlanError';
    this.issues = issues;
  }
}

/** FPL's own short names for the four element types. */
const POSITION_BY_SHORT_NAME: Record<string, Position> = {
  GKP: 'GKP',
  DEF: 'DEF',
  MID: 'MID',
  FWD: 'FWD',
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The season a payload describes, derived from its earliest gameweek deadline.
 *
 * FPL never states the season anywhere in `bootstrap-static`; it just serves
 * whichever one is live. A deadline in July or later opens the season named for
 * that year, so 2025-08-15 → 2025/26. The Jan–Jun branch covers the second half
 * of a season, where GW1's deadline has long since passed and only later
 * gameweeks remain to date it.
 */
export function deriveSeason(events: FplEvent[]): SeasonPlan {
  let earliest: Date | null = null;
  for (const event of events) {
    if (!event.deadline_time) continue;
    const at = new Date(event.deadline_time);
    if (Number.isNaN(at.getTime())) continue;
    if (!earliest || at.getTime() < earliest.getTime()) earliest = at;
  }

  if (!earliest) {
    throw new BootstrapPlanError([
      'no event carries a usable deadline_time, so the season cannot be dated',
    ]);
  }

  const year = earliest.getUTCFullYear();
  const startYear = earliest.getUTCMonth() >= 6 ? year : year - 1;
  const endYear = String((startYear + 1) % 100).padStart(2, '0');

  return { name: `${startYear}/${endYear}`, startYear };
}

function parseDateOnly(value: string | null, label: string, issues: string[]): Date | null {
  if (value === null || value === '') return null;
  if (!DATE_ONLY.test(value)) {
    issues.push(`${label}: expected a YYYY-MM-DD date, got "${value}"`);
    return null;
  }
  const at = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) {
    issues.push(`${label}: "${value}" is not a real date`);
    return null;
  }
  return at;
}

function parseTimestamp(value: string | null, label: string, issues: string[]): Date | null {
  if (value === null || value === '') return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    issues.push(`${label}: "${value}" is not a parseable timestamp`);
    return null;
  }
  return at;
}

function planClubs(teams: FplTeam[], issues: string[]): PlannedClub[] {
  const seenCodes = new Set<number>();
  const seenIds = new Set<number>();

  return teams.map((team) => {
    if (seenCodes.has(team.code)) issues.push(`two teams share code ${team.code}`);
    if (seenIds.has(team.id)) issues.push(`two teams share id ${team.id}`);
    seenCodes.add(team.code);
    seenIds.add(team.id);

    return {
      identity: {
        fplCode: team.code,
        pulseId: team.pulse_id ?? null,
        name: team.name,
        shortName: team.short_name,
      },
      season: {
        fplId: team.id,
        strength: team.strength,
        strengthOverallHome: team.strength_overall_home,
        strengthOverallAway: team.strength_overall_away,
        strengthAttackHome: team.strength_attack_home,
        strengthAttackAway: team.strength_attack_away,
        strengthDefenceHome: team.strength_defence_home,
        strengthDefenceAway: team.strength_defence_away,
      },
    };
  });
}

function planPlayers(
  elements: FplElement[],
  clubCodeByFplId: Map<number, number>,
  positionByTypeId: Map<number, Position>,
  issues: string[],
  warnings: string[],
): PlannedPlayer[] {
  const seenCodes = new Set<number>();
  const seenOptaCodes = new Set<string>();
  const planned: PlannedPlayer[] = [];

  for (const element of elements) {
    const label = `element ${element.id} (${element.web_name})`;

    const clubFplCode = clubCodeByFplId.get(element.team);
    if (clubFplCode === undefined) {
      issues.push(`${label}: team ${element.team} is not in this payload`);
      continue;
    }

    const position = positionByTypeId.get(element.element_type);
    if (position === undefined) {
      issues.push(`${label}: element_type ${element.element_type} is not in this payload`);
      continue;
    }

    if (seenCodes.has(element.code)) issues.push(`${label}: code ${element.code} is not unique`);
    seenCodes.add(element.code);

    if (element.opta_code !== null) {
      if (seenOptaCodes.has(element.opta_code)) {
        issues.push(`${label}: opta_code ${element.opta_code} is not unique`);
      }
      seenOptaCodes.add(element.opta_code);
    }

    // `team_code` is redundant with `team`, and disagreement between them means
    // FPL is mid-write on a transfer. `team` is the one fixtures and live data
    // are keyed on, so trust it — but say so.
    if (element.team_code !== clubFplCode) {
      warnings.push(
        `${label}: team ${element.team} maps to club code ${clubFplCode} ` +
          `but team_code says ${element.team_code}; using team`,
      );
    }

    planned.push({
      identity: {
        fplCode: element.code,
        optaCode: element.opta_code,
        firstName: element.first_name,
        secondName: element.second_name,
        webName: element.web_name,
        birthDate: parseDateOnly(element.birth_date, `${label} birth_date`, issues),
      },
      clubFplCode,
      season: {
        fplId: element.id,
        position,
        status: element.status,
        chanceOfPlayingThisRound: element.chance_of_playing_this_round,
        chanceOfPlayingNextRound: element.chance_of_playing_next_round,
        news: element.news,
        newsAddedAt: parseTimestamp(element.news_added, `${label} news_added`, issues),
        squadNumber: element.squad_number,
        teamJoinDate: parseDateOnly(element.team_join_date, `${label} team_join_date`, issues),
        nowCost: element.now_cost,
        selectedByPercent: element.selected_by_percent,
      },
    });
  }

  return planned;
}

function planGameweeks(events: FplEvent[], issues: string[]): PlannedGameweek[] {
  const seen = new Set<number>();

  return events.map((event) => {
    if (seen.has(event.id)) issues.push(`two events share id ${event.id}`);
    seen.add(event.id);

    return {
      number: event.id,
      name: event.name,
      deadlineTime: parseTimestamp(event.deadline_time, `event ${event.id} deadline_time`, issues),
      finished: event.finished,
      dataChecked: event.data_checked,
      isPrevious: event.is_previous,
      isCurrent: event.is_current,
      isNext: event.is_next,
      averageEntryScore:
        event.average_entry_score === null ? null : Math.round(event.average_entry_score),
      highestScore: event.highest_score === null ? null : Math.round(event.highest_score),
    };
  });
}

/**
 * Turn a parsed `bootstrap-static` payload into the rows the reference tables
 * want. Pure: no clock, no database, no network.
 */
export function planBootstrap(
  payload: FplBootstrapStatic,
  options?: { season?: SeasonPlan },
): BootstrapPlan {
  const issues: string[] = [];
  const warnings: string[] = [];

  const positionByTypeId = new Map<number, Position>();
  for (const type of payload.element_types) {
    const position = POSITION_BY_SHORT_NAME[type.singular_name_short];
    if (!position) {
      issues.push(
        `element_type ${type.id}: unknown position "${type.singular_name_short}" ` +
          '(expected one of GKP, DEF, MID, FWD)',
      );
      continue;
    }
    positionByTypeId.set(type.id, position);
  }

  const clubs = planClubs(payload.teams, issues);
  const clubCodeByFplId = new Map(clubs.map((c) => [c.season.fplId, c.identity.fplCode]));
  const players = planPlayers(payload.elements, clubCodeByFplId, positionByTypeId, issues, warnings);
  const gameweeks = planGameweeks(payload.events, issues);

  let season: SeasonPlan | null = options?.season ?? null;
  if (season === null) {
    try {
      season = deriveSeason(payload.events);
    } catch (error) {
      // Collect it alongside the rest rather than losing every other issue to
      // whichever one happens to throw first.
      issues.push(error instanceof BootstrapPlanError ? error.issues.join('; ') : String(error));
    }
  }

  if (season === null || issues.length > 0) throw new BootstrapPlanError(issues);

  return { season, clubs, players, gameweeks, warnings };
}
