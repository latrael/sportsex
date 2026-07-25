// R2.3 — season-to-date aggregates, as a pure function of the stored event rows.
//
// The principle this exists to enforce (REBUILD_PLAN §"Enforced invariants" #4):
// **events are immutable, aggregates are derived**. v1 incremented season totals
// in place as stats arrived, which is why it needed `recalc-stats.ts`,
// `patch-minutes.ts` and `reset-for-resync.ts` to repair the drift that always
// followed. A recompute has no drift to repair: run it twice and the second run
// changes nothing, because the answer is a function of rows that never move.
//
// Same shape as every Phase 1 planner: rows in, rows out, no clock, no database,
// no network. That is what makes invariant 4 testable without a database, and
// what lets R3.6's backtest replay a season through the same code.
//
// ---------------------------------------------------------------------------
// **Which grain each field comes from**, and why it is not the one the task
// assumed.
//
// R2.1's schema comment and the invariant both say the counting stats are
// summed from `player_fixture_stat`. Measured against the live payloads, that is
// wrong, and quietly so. **FPL's `explain` block is a points ledger, not a stat
// line**: it lists an identifier only when that identifier actually scored or
// deducted points. Over the two sample gameweeks (38 element-weeks):
//
//   minutes, goals, assists, own goals, penalties saved/missed, yellow, red,
//   bonus, total points          — explain == stats for every element
//   clean sheets                 — explain < stats for 3   (a FWD's clean sheet scores 0)
//   goals conceded               — explain < stats for 21  (scores only per 2, and only GKP/DEF)
//   saves                        — explain < stats for 4   (scores only per 3)
//   defensive contribution       — explain < stats for 25  (scores only at the threshold)
//
// Never the other way round. So summing the per-fixture grain would under-report
// exactly the defensive stats R3.1's defence score is built from — a keeper's
// saves and a defender's clean sheets — for every live-ingested season.
//
// The rule this file therefore holds:
//
//   - **Every summed stat comes from `player_gameweek_stat`**, which is FPL's
//     `stats` block stored verbatim and is complete for all 29 fields. On a
//     double gameweek that row already covers both fixtures, so summing it
//     across the season is exact.
//   - **`appearances` comes from `player_fixture_stat`**, because it is a count
//     of fixtures rather than a sum, and the per-fixture grain is the only place
//     that knows a double gameweek was two matches.
//
// This does not weaken invariant 4 — both tables are immutable event rows and
// nothing here increments — but it does correct which table the invariant names.
// 25/26 is unaffected either way: it came from the archive, whose per-fixture
// rows are complete, so the two grains agree exactly for all 841 players.
// ---------------------------------------------------------------------------

import { Prisma } from '@prisma/client';

/** One `player_fixture_stat` row, narrowed to what the aggregate needs. */
export type FixtureStatRow = {
  playerSeasonId: number;
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
  totalPoints: number;
};

/** One `player_gameweek_stat` row, narrowed to what the aggregate needs. */
export type GameweekStatRow = {
  playerSeasonId: number;
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
  totalPoints: number;
  influence: Prisma.Decimal.Value;
  creativity: Prisma.Decimal.Value;
  threat: Prisma.Decimal.Value;
  ictIndex: Prisma.Decimal.Value;
  expectedGoals: Prisma.Decimal.Value;
  expectedAssists: Prisma.Decimal.Value;
  expectedGoalInvolvements: Prisma.Decimal.Value;
  expectedGoalsConceded: Prisma.Decimal.Value;
};

export type PlannedSeasonStat = {
  playerSeasonId: number;

  appearances: number;
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
  defensiveContribution: number;
  totalPoints: number;

  bps: number;
  tackles: number;
  recoveries: number;
  clearancesBlocksInterceptions: number;

  influence: Prisma.Decimal;
  creativity: Prisma.Decimal;
  threat: Prisma.Decimal;
  ictIndex: Prisma.Decimal;
  expectedGoals: Prisma.Decimal;
  expectedAssists: Prisma.Decimal;
  expectedGoalInvolvements: Prisma.Decimal;
  expectedGoalsConceded: Prisma.Decimal;
};

export type SeasonStatsPlan = {
  stats: PlannedSeasonStat[];
  warnings: string[];
};

/**
 * Raised when the event rows reference a player the season doesn't contain.
 * Always a caller bug — the rows and the player list must come from the same
 * season — so it fails whole rather than dropping the orphan silently.
 */
export class SeasonStatsPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeasonStatsPlanError';
  }
}

/** Integer stats summed straight from the gameweek grain. */
const SUMMED_INT_FIELDS = [
  'minutes',
  'starts',
  'goalsScored',
  'assists',
  'cleanSheets',
  'goalsConceded',
  'ownGoals',
  'penaltiesSaved',
  'penaltiesMissed',
  'yellowCards',
  'redCards',
  'saves',
  'bonus',
  'defensiveContribution',
  'totalPoints',
  'bps',
  'tackles',
  'recoveries',
  'clearancesBlocksInterceptions',
] as const satisfies readonly (keyof GameweekStatRow & keyof PlannedSeasonStat)[];

const DECIMAL_FIELDS = [
  'influence',
  'creativity',
  'threat',
  'ictIndex',
  'expectedGoals',
  'expectedAssists',
  'expectedGoalInvolvements',
  'expectedGoalsConceded',
] as const satisfies readonly (keyof GameweekStatRow & keyof PlannedSeasonStat)[];

/**
 * Identifiers that always score points, so `explain` reports them in full. The
 * two grains must agree exactly; a difference is a lost or double-counted
 * fixture.
 */
const EXACT_ACROSS_GRAINS = [
  'minutes',
  'goalsScored',
  'assists',
  'ownGoals',
  'penaltiesSaved',
  'penaltiesMissed',
  'yellowCards',
  'redCards',
  'bonus',
  'totalPoints',
] as const satisfies readonly (keyof FixtureStatRow & keyof GameweekStatRow)[];

/**
 * Identifiers that score only conditionally (a clean sheet is worth nothing to a
 * forward; goals conceded deduct only per two; saves score per three; defensive
 * contribution only at its threshold), so `explain` omits them when they earned
 * nothing. The per-fixture grain may legitimately fall short of the gameweek
 * total — but it can never exceed it, and that direction is a real fault.
 */
const AT_MOST_ACROSS_GRAINS = [
  'cleanSheets',
  'goalsConceded',
  'saves',
  'defensiveContribution',
] as const satisfies readonly (keyof FixtureStatRow & keyof GameweekStatRow)[];

/**
 * Compile-time proof that the two field lists above, plus the two fields the
 * per-fixture grain owns, cover every field of `PlannedSeasonStat`. Without it
 * the cast in `zero()` would let a newly added column leave the aggregate
 * undefined, and the first sign would be a NOT NULL violation at write time.
 */
type UncoveredField = Exclude<
  keyof PlannedSeasonStat,
  'playerSeasonId' | 'appearances' | (typeof SUMMED_INT_FIELDS)[number] | (typeof DECIMAL_FIELDS)[number]
>;
const _everyFieldIsCovered: UncoveredField extends never ? true : never = true;
void _everyFieldIsCovered;

function zero(playerSeasonId: number): PlannedSeasonStat {
  const stat = { playerSeasonId, appearances: 0 } as PlannedSeasonStat;
  for (const field of SUMMED_INT_FIELDS) stat[field] = 0;
  for (const field of DECIMAL_FIELDS) stat[field] = new Prisma.Decimal(0);
  return stat;
}

/**
 * Aggregate a season's event rows into one row per player.
 *
 * `playerSeasonIds` is the full membership of the season, not just the players
 * who have event rows. Every one of them gets a row, zeros included: it makes
 * `player_season_stat` a total function of `player_season`, so R3.x can join
 * without a left-join-and-coalesce on every read, and "played nothing" is stored
 * as the fact it is rather than as an absence indistinguishable from a gap in
 * ingestion. Before GW1 of a new season, every row is zeros — which is correct.
 */
export function planSeasonStats(input: {
  playerSeasonIds: readonly number[];
  fixtureStats: readonly FixtureStatRow[];
  gameweekStats: readonly GameweekStatRow[];
}): SeasonStatsPlan {
  const byPlayer = new Map<number, PlannedSeasonStat>();
  for (const id of input.playerSeasonIds) byPlayer.set(id, zero(id));

  const get = (playerSeasonId: number, table: string): PlannedSeasonStat => {
    const agg = byPlayer.get(playerSeasonId);
    if (!agg) {
      throw new SeasonStatsPlanError(
        `${table} references playerSeasonId ${playerSeasonId}, which is not in this season`,
      );
    }
    return agg;
  };

  // Per-fixture grain: appearances only. An appearance is a fixture the player
  // was on the pitch for — deliberately not `starts`, since a substitute who
  // plays 20 minutes has appeared.
  for (const row of input.fixtureStats) {
    const agg = get(row.playerSeasonId, 'player_fixture_stat');
    if (row.minutes > 0) agg.appearances += 1;
  }

  // Per-gameweek grain: every summed stat. See the note at the top of the file
  // for why the counting stats come from here rather than from `explain`.
  for (const row of input.gameweekStats) {
    const agg = get(row.playerSeasonId, 'player_gameweek_stat');
    for (const field of SUMMED_INT_FIELDS) agg[field] += row[field];
    for (const field of DECIMAL_FIELDS) {
      agg[field] = agg[field].plus(new Prisma.Decimal(row[field]));
    }
  }

  return {
    stats: [...byPlayer.values()],
    warnings: crossGrainWarnings(input.fixtureStats, input.gameweekStats),
  };
}

/**
 * The check the two grains buy us for free: per player, the per-fixture sums
 * must line up with the per-gameweek sums. FPL derives both from the same match,
 * so a fixture grain that *exceeds* the gameweek total means an ingest
 * double-counted a fixture, and a shortfall in an always-scoring identifier
 * means one was lost. Either is the failure a stored-and-incremented total would
 * have hidden.
 *
 * It warns rather than throws: the aggregate is taken from the complete grain
 * regardless, and taking a nightly job down over one inconsistent player would
 * be the wrong trade (the same rule as R1.2's ingest).
 */
function crossGrainWarnings(
  fixtureStats: readonly FixtureStatRow[],
  gameweekStats: readonly GameweekStatRow[],
): string[] {
  const CHECKED = [...EXACT_ACROSS_GRAINS, ...AT_MOST_ACROSS_GRAINS];
  const sums = new Map<number, { fixture: number[]; gameweek: number[] }>();
  const slot = (id: number) => {
    let s = sums.get(id);
    if (!s) {
      s = { fixture: CHECKED.map(() => 0), gameweek: CHECKED.map(() => 0) };
      sums.set(id, s);
    }
    return s;
  };

  for (const row of fixtureStats) {
    const s = slot(row.playerSeasonId);
    CHECKED.forEach((f, i) => (s.fixture[i] += row[f]));
  }
  for (const row of gameweekStats) {
    const s = slot(row.playerSeasonId);
    CHECKED.forEach((f, i) => (s.gameweek[i] += row[f]));
  }

  // Every id here is known: planSeasonStats throws on an unknown one before
  // this runs.
  const warnings: string[] = [];
  for (const [playerSeasonId, s] of sums) {
    CHECKED.forEach((field, i) => {
      const perFixture = s.fixture[i];
      const perGameweek = s.gameweek[i];
      const exact = (EXACT_ACROSS_GRAINS as readonly string[]).includes(field);
      if (perFixture > perGameweek || (exact && perFixture !== perGameweek)) {
        warnings.push(
          `playerSeasonId ${playerSeasonId}: ${field} sums to ${perFixture} per fixture but ${perGameweek} per gameweek`,
        );
      }
    });
  }
  return warnings;
}
