// event/{gw}/live → per-fixture and per-gameweek player stats, as a pure
// function. Same split as the other planners: payload in, rows out, no clock,
// no database, no network.
//
// The design problem R1.4 exists to solve is that FPL reports a gameweek's
// stats at two grains, and only one of them is per fixture:
//
//   - `explain` splits the point-scoring identifiers by fixture. This is the
//     only per-fixture attribution FPL gives, and the only thing that makes a
//     double gameweek correct. It becomes `player_fixture_stat`.
//   - `stats` is the gameweek total for all 29 fields, including the ~20 model
//     inputs (xG, xA, xGC, tackles, recoveries, bps, ICT) that appear *nowhere*
//     per fixture. It becomes `player_gameweek_stat`, one row per player-week.
//
// So on a double gameweek, goals/assists/minutes/etc. are split honestly across
// the two fixtures, and xG stays a single combined gameweek number rather than
// a fabricated split. R3.1 inherits that gameweek-grain xG and decides what to
// do with it; nothing here guesses.

import type { FplEventLive, FplLiveElement, FplLiveStats } from '@/lib/fpl';

/** One player's line for one fixture, split out of `explain`. */
export type PlannedFixtureStat = {
  /** `element.id` — season-scoped, resolved via `player_season` by sync. */
  playerFplId: number;
  /** `explain[].fixture` — season-scoped, resolved via `fixture` by sync. */
  fixtureFplId: number;

  minutes: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  defensiveContribution: number;
  /** Sum of the `explain` points for this fixture: FPL's own per-fixture score. */
  totalPoints: number;
};

/** One player's gameweek total, taken verbatim from `stats`. */
export type PlannedGameweekStat = {
  playerFplId: number;

  minutes: number;
  starts: number;
  goalsScored: number;
  assists: number;
  cleanSheets: number;
  goalsConceded: number;
  ownGoals: number;
  penaltiesSaved: number;
  penaltiesMissed: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  bps: number;
  tackles: number;
  recoveries: number;
  clearancesBlocksInterceptions: number;
  defensiveContribution: number;
  /** Kept as the strings the wire carried, for the Decimal columns (see R1.1). */
  influence: string;
  creativity: string;
  threat: string;
  ictIndex: string;
  expectedGoals: string;
  expectedAssists: string;
  expectedGoalInvolvements: string;
  expectedGoalsConceded: string;
  totalPoints: number;
};

export type EventLivePlan = {
  fixtureStats: PlannedFixtureStat[];
  gameweekStats: PlannedGameweekStat[];
  /** See BootstrapPlan.warnings for why this is kept apart from the throw path. */
  warnings: string[];
};

export class EventLivePlanError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    const shown = issues.slice(0, 5).join('; ');
    const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
    super(`event-live payload is not internally consistent — ${shown}${more}`);
    this.name = 'EventLivePlanError';
    this.issues = issues;
  }
}

/**
 * The `explain` identifiers that map to a per-fixture column. FPL only lists an
 * identifier when it fired, so anything absent is genuinely zero for that
 * fixture — the columns default to 0. Any identifier not in this map is
 * point-scoring FPL has newly added; it is surfaced as a warning (and retained
 * in the raw payload) rather than silently dropped.
 */
const FIXTURE_STAT_FIELD: Record<string, keyof PlannedFixtureStat> = {
  minutes: 'minutes',
  goals_scored: 'goalsScored',
  assists: 'assists',
  clean_sheets: 'cleanSheets',
  goals_conceded: 'goalsConceded',
  own_goals: 'ownGoals',
  penalties_saved: 'penaltiesSaved',
  penalties_missed: 'penaltiesMissed',
  yellow_cards: 'yellowCards',
  red_cards: 'redCards',
  saves: 'saves',
  bonus: 'bonus',
  defensive_contribution: 'defensiveContribution',
};

function emptyFixtureStat(playerFplId: number, fixtureFplId: number): PlannedFixtureStat {
  return {
    playerFplId,
    fixtureFplId,
    minutes: 0,
    goalsScored: 0,
    assists: 0,
    cleanSheets: 0,
    goalsConceded: 0,
    ownGoals: 0,
    penaltiesSaved: 0,
    penaltiesMissed: 0,
    yellowCards: 0,
    redCards: 0,
    saves: 0,
    bonus: 0,
    defensiveContribution: 0,
    totalPoints: 0,
  };
}

function gameweekStatOf(element: FplLiveElement): PlannedGameweekStat {
  const s: FplLiveStats = element.stats;
  return {
    playerFplId: element.id,
    minutes: s.minutes,
    starts: s.starts,
    goalsScored: s.goals_scored,
    assists: s.assists,
    cleanSheets: s.clean_sheets,
    goalsConceded: s.goals_conceded,
    ownGoals: s.own_goals,
    penaltiesSaved: s.penalties_saved,
    penaltiesMissed: s.penalties_missed,
    yellowCards: s.yellow_cards,
    redCards: s.red_cards,
    saves: s.saves,
    bonus: s.bonus,
    bps: s.bps,
    tackles: s.tackles,
    recoveries: s.recoveries,
    clearancesBlocksInterceptions: s.clearances_blocks_interceptions,
    defensiveContribution: s.defensive_contribution,
    influence: s.influence,
    creativity: s.creativity,
    threat: s.threat,
    ictIndex: s.ict_index,
    expectedGoals: s.expected_goals,
    expectedAssists: s.expected_assists,
    expectedGoalInvolvements: s.expected_goal_involvements,
    expectedGoalsConceded: s.expected_goals_conceded,
    totalPoints: s.total_points,
  };
}

/**
 * Turn a parsed `event/{gw}/live` payload into fixture-grain and gameweek-grain
 * rows. Pure: no clock, no database, no network.
 */
export function planEventLive(payload: FplEventLive): EventLivePlan {
  const issues: string[] = [];
  const warnings: string[] = [];
  const unknownIdentifiers = new Set<string>();

  const fixtureStats: PlannedFixtureStat[] = [];
  const gameweekStats: PlannedGameweekStat[] = [];

  const seenElements = new Set<number>();

  for (const element of payload.elements) {
    if (seenElements.has(element.id)) {
      issues.push(`element ${element.id} appears more than once`);
      continue;
    }
    seenElements.add(element.id);

    gameweekStats.push(gameweekStatOf(element));

    const seenFixtures = new Set<number>();
    let explainMinutes = 0;

    for (const entry of element.explain) {
      // Two rows for one (player, fixture) can't both be written — the unique
      // constraint would reject the second. A payload that lists a fixture
      // twice for one player is malformed, so fail rather than pick one.
      if (seenFixtures.has(entry.fixture)) {
        issues.push(`element ${element.id}: fixture ${entry.fixture} appears twice in explain`);
        continue;
      }
      seenFixtures.add(entry.fixture);

      const row = emptyFixtureStat(element.id, entry.fixture);
      for (const stat of entry.stats) {
        const field = FIXTURE_STAT_FIELD[stat.identifier];
        if (field === undefined) {
          unknownIdentifiers.add(stat.identifier);
        } else {
          (row[field] as number) = stat.value;
        }
        row.totalPoints += stat.points;
      }
      explainMinutes += row.minutes;
      fixtureStats.push(row);
    }

    // The free cross-check R1.4's note calls out: `explain` minutes, summed
    // across a player's fixtures, must equal the `stats` gameweek total. A
    // mismatch means the per-fixture split doesn't reconcile with the total —
    // exactly the attribution bug this table exists to get right — so it warns
    // loudly. A player with recorded minutes but no explain entries has a
    // gameweek total that lands in no fixture at all.
    if (element.stats.minutes > 0 && element.explain.length === 0) {
      warnings.push(
        `element ${element.id}: ${element.stats.minutes} minutes but no explain entries`,
      );
    } else if (explainMinutes !== element.stats.minutes) {
      warnings.push(
        `element ${element.id}: explain minutes (${explainMinutes}) ` +
          `disagree with the gameweek total (${element.stats.minutes})`,
      );
    }
  }

  for (const identifier of unknownIdentifiers) {
    warnings.push(`unmapped explain identifier "${identifier}" — retained in raw only`);
  }

  if (issues.length > 0) throw new EventLivePlanError(issues);

  return { fixtureStats, gameweekStats, warnings };
}
