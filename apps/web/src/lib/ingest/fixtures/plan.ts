// fixtures → the fixture table, as a pure function.
//
// Same shape as the bootstrap planner: payload in, rows out, no clock, no
// database, no network. The difference is what the payload references. Nothing
// here carries a stable identifier — `fixture.team_h` and `fixture.team_a` are
// season-scoped team ids, and `fixture.event` is a season-scoped gameweek
// number — so the plan keeps them as-is and sync resolves them through
// `club_season` and `gameweek` on `(seasonId, fplId)` / `(seasonId, number)`.

import type { FplFixture } from '@/lib/fpl';

export type PlannedFixture = {
  fplId: number;
  code: number;
  /** Season-scoped gameweek number, or null while FPL has not scheduled it. */
  gameweekNumber: number | null;
  /** Season-scoped club ids, resolved against `club_season` by sync. */
  homeClubFplId: number;
  awayClubFplId: number;

  kickoffTime: Date | null;
  started: boolean | null;
  finished: boolean;
  finishedProvisional: boolean;
  provisionalStartTime: boolean;
  minutes: number;

  homeScore: number | null;
  awayScore: number | null;
  homeDifficulty: number;
  awayDifficulty: number;
};

export type FixturesPlan = {
  fixtures: PlannedFixture[];
  /** See BootstrapPlan.warnings for why this is separate from the throw path. */
  warnings: string[];
};

export class FixturesPlanError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    const shown = issues.slice(0, 5).join('; ');
    const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
    super(`fixtures payload is not internally consistent — ${shown}${more}`);
    this.name = 'FixturesPlanError';
    this.issues = issues;
  }
}

export function planFixtures(payload: FplFixture[]): FixturesPlan {
  const issues: string[] = [];
  const warnings: string[] = [];

  const seenIds = new Set<number>();
  const seenCodes = new Set<number>();
  const fixtures: PlannedFixture[] = [];

  for (const fixture of payload) {
    const label = `fixture ${fixture.id}`;

    if (seenIds.has(fixture.id)) issues.push(`${label}: id is not unique`);
    seenIds.add(fixture.id);

    if (seenCodes.has(fixture.code)) issues.push(`${label}: code ${fixture.code} is not unique`);
    seenCodes.add(fixture.code);

    if (fixture.team_h === fixture.team_a) {
      issues.push(`${label}: team ${fixture.team_h} is listed as both home and away`);
      continue;
    }

    // A half-populated scoreline is not a state a match can be in. Storing it
    // would put a fixture in the backfill that no reconciliation could balance.
    const scoresKnown = [fixture.team_h_score, fixture.team_a_score].filter(
      (score) => score !== null,
    ).length;
    if (scoresKnown === 1) {
      issues.push(
        `${label}: one side has a score and the other does not ` +
          `(${fixture.team_h_score} / ${fixture.team_a_score})`,
      );
      continue;
    }

    let kickoffTime: Date | null = null;
    if (fixture.kickoff_time !== null && fixture.kickoff_time !== '') {
      kickoffTime = new Date(fixture.kickoff_time);
      if (Number.isNaN(kickoffTime.getTime())) {
        issues.push(`${label}: kickoff_time "${fixture.kickoff_time}" is not a parseable timestamp`);
        continue;
      }
    }

    // Transient states FPL genuinely passes through, so they warn rather than
    // fail: a finished match is briefly not yet marked started, and a
    // rescheduled one loses its event for a while.
    if (fixture.finished && fixture.started === false) {
      warnings.push(`${label}: marked finished but not started`);
    }
    if (fixture.finished && scoresKnown === 0) {
      warnings.push(`${label}: marked finished but has no score`);
    }
    if (fixture.event === null && fixture.finished) {
      warnings.push(`${label}: finished but not attached to a gameweek`);
    }

    fixtures.push({
      fplId: fixture.id,
      code: fixture.code,
      gameweekNumber: fixture.event,
      homeClubFplId: fixture.team_h,
      awayClubFplId: fixture.team_a,
      kickoffTime,
      started: fixture.started,
      finished: fixture.finished,
      finishedProvisional: fixture.finished_provisional,
      provisionalStartTime: fixture.provisional_start_time,
      minutes: fixture.minutes,
      homeScore: fixture.team_h_score,
      awayScore: fixture.team_a_score,
      homeDifficulty: fixture.team_h_difficulty,
      awayDifficulty: fixture.team_a_difficulty,
    });
  }

  if (issues.length > 0) throw new FixturesPlanError(issues);

  return { fixtures, warnings };
}
