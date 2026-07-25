// Build an EventLivePlan (R1.4's shape) for one gameweek from the archive's
// per-player-per-fixture gws rows.
//
// The archive is richer than the live endpoint: it gives per-fixture xG, bps,
// tackles and so on, which the live `event/{gw}/live` reports only as gameweek
// totals. To keep 25/26 and 26/27+ uniform — same two tables, same grain — the
// model-input stats are aggregated back to the gameweek total here, exactly the
// grain the live path will produce. The per-fixture scoring stats stay per
// fixture, so double gameweeks split correctly either way.

import { Prisma } from '@prisma/client';
import type { CsvRow } from './csv';
import type { EventLivePlan, PlannedFixtureStat, PlannedGameweekStat } from '../live/plan';
import { int } from './coerce';

function fixtureStat(row: CsvRow): PlannedFixtureStat {
  return {
    playerFplId: int(row.element, 'gws.element'),
    fixtureFplId: int(row.fixture, 'gws.fixture'),
    minutes: int(row.minutes, 'gws.minutes'),
    goalsScored: int(row.goals_scored, 'gws.goals_scored'),
    assists: int(row.assists, 'gws.assists'),
    cleanSheets: int(row.clean_sheets, 'gws.clean_sheets'),
    goalsConceded: int(row.goals_conceded, 'gws.goals_conceded'),
    ownGoals: int(row.own_goals, 'gws.own_goals'),
    penaltiesSaved: int(row.penalties_saved, 'gws.penalties_saved'),
    penaltiesMissed: int(row.penalties_missed, 'gws.penalties_missed'),
    yellowCards: int(row.yellow_cards, 'gws.yellow_cards'),
    redCards: int(row.red_cards, 'gws.red_cards'),
    saves: int(row.saves, 'gws.saves'),
    bonus: int(row.bonus, 'gws.bonus'),
    defensiveContribution: int(row.defensive_contribution, 'gws.defensive_contribution'),
    totalPoints: int(row.total_points, 'gws.total_points'),
  };
}

const DECIMAL_FIELDS = [
  'influence',
  'creativity',
  'threat',
  'ict_index',
  'expected_goals',
  'expected_assists',
  'expected_goal_involvements',
  'expected_goals_conceded',
] as const;

const INT_FIELDS = [
  'minutes',
  'starts',
  'goals_scored',
  'assists',
  'clean_sheets',
  'goals_conceded',
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'bonus',
  'bps',
  'tackles',
  'recoveries',
  'clearances_blocks_interceptions',
  'defensive_contribution',
  'total_points',
] as const;

/** Sum one column across a player's fixtures for the gameweek. */
function sumInt(rows: CsvRow[], field: string): number {
  return rows.reduce((n, r) => n + int(r[field], `gws.${field}`), 0);
}

function sumDecimal(rows: CsvRow[], field: string): string {
  return rows
    .reduce((acc, r) => acc.plus(new Prisma.Decimal(r[field] || '0')), new Prisma.Decimal(0))
    .toString();
}

function gameweekStat(playerFplId: number, rows: CsvRow[]): PlannedGameweekStat {
  const ints = Object.fromEntries(INT_FIELDS.map((f) => [f, sumInt(rows, f)])) as Record<
    (typeof INT_FIELDS)[number],
    number
  >;
  const decs = Object.fromEntries(DECIMAL_FIELDS.map((f) => [f, sumDecimal(rows, f)])) as Record<
    (typeof DECIMAL_FIELDS)[number],
    string
  >;
  return {
    playerFplId,
    minutes: ints.minutes,
    starts: ints.starts,
    goalsScored: ints.goals_scored,
    assists: ints.assists,
    cleanSheets: ints.clean_sheets,
    goalsConceded: ints.goals_conceded,
    ownGoals: ints.own_goals,
    penaltiesSaved: ints.penalties_saved,
    penaltiesMissed: ints.penalties_missed,
    yellowCards: ints.yellow_cards,
    redCards: ints.red_cards,
    saves: ints.saves,
    bonus: ints.bonus,
    bps: ints.bps,
    tackles: ints.tackles,
    recoveries: ints.recoveries,
    clearancesBlocksInterceptions: ints.clearances_blocks_interceptions,
    defensiveContribution: ints.defensive_contribution,
    influence: decs.influence,
    creativity: decs.creativity,
    threat: decs.threat,
    ictIndex: decs.ict_index,
    expectedGoals: decs.expected_goals,
    expectedAssists: decs.expected_assists,
    expectedGoalInvolvements: decs.expected_goal_involvements,
    expectedGoalsConceded: decs.expected_goals_conceded,
    totalPoints: ints.total_points,
  };
}

/** A stat signature, to tell a harmless duplicate from a real conflict. */
function signature(row: CsvRow): string {
  return [...INT_FIELDS, ...DECIMAL_FIELDS].map((f) => row[f]).join('|');
}

/**
 * Drop duplicate `(element, fixture)` rows. The archive occasionally emits a
 * player twice for one fixture (byte-for-byte identical — seen for elements 100
 * and 391 in 25/26). Left in, they'd break the `(playerSeasonId, fixtureId)`
 * unique constraint and, worse, double-count that fixture in the gameweek
 * aggregate. Identical duplicates collapse silently; a duplicate that actually
 * disagrees is a real problem, so it keeps the first and warns.
 */
function dedupe(rows: CsvRow[], warnings: string[]): CsvRow[] {
  const seen = new Map<string, string>();
  const kept: CsvRow[] = [];
  for (const row of rows) {
    const key = `${row.element}:${row.fixture}`;
    const sig = signature(row);
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, sig);
      kept.push(row);
    } else if (prior !== sig) {
      warnings.push(
        `element ${row.element} fixture ${row.fixture}: conflicting duplicate rows, kept the first`,
      );
    }
  }
  return kept;
}

/**
 * Turn one gameweek's gws rows into an EventLivePlan. Pure: no database.
 * Rows are grouped by `element`; a player with two fixtures yields two
 * fixture-stat rows and one aggregated gameweek-stat row.
 */
export function buildEventLivePlan(rawRows: CsvRow[]): EventLivePlan {
  const warnings: string[] = [];
  const rows = dedupe(rawRows, warnings);

  const byElement = new Map<number, CsvRow[]>();
  const fixtureStats: PlannedFixtureStat[] = [];

  for (const row of rows) {
    const element = int(row.element, 'gws.element');
    const list = byElement.get(element);
    if (list) list.push(row);
    else byElement.set(element, [row]);
    fixtureStats.push(fixtureStat(row));
  }

  const gameweekStats = [...byElement.entries()].map(([element, rs]) => gameweekStat(element, rs));

  return { fixtureStats, gameweekStats, warnings };
}
