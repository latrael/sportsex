// Typed schemas for the three FPL endpoints we ingest.
//
// Two rules hold throughout:
//
// 1. Every object schema is `.passthrough()`. FPL adds fields mid-season without
//    notice (`defensive_contribution` appeared in 25/26). Unknown fields must not
//    fail a parse, and the raw payload is retained anyway, so nothing is lost.
// 2. Decimal-valued fields stay `string`, exactly as the wire carries them
//    ("expected_goals": "0.07"). Parsing them to JS numbers here would put a
//    float in front of every downstream Decimal column; Prisma takes the string
//    directly.

import { z } from 'zod';

/** A decimal the API sends as a string. Kept as a string on purpose — see above. */
const decimalString = z.string();

// ---------------------------------------------------------------- bootstrap-static

export const fplTeamSchema = z
  .object({
    id: z.number().int(),
    code: z.number().int(),
    name: z.string(),
    short_name: z.string(),
    strength: z.number().int(),
    strength_overall_home: z.number().int(),
    strength_overall_away: z.number().int(),
    strength_attack_home: z.number().int(),
    strength_attack_away: z.number().int(),
    strength_defence_home: z.number().int(),
    strength_defence_away: z.number().int(),
    pulse_id: z.number().int(),
  })
  .passthrough();

export const fplElementTypeSchema = z
  .object({
    id: z.number().int(),
    singular_name: z.string(),
    singular_name_short: z.string(),
    plural_name: z.string(),
    plural_name_short: z.string(),
    element_count: z.number().int(),
  })
  .passthrough();

export const fplEventSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    deadline_time: z.string().nullable(),
    finished: z.boolean(),
    data_checked: z.boolean(),
    is_previous: z.boolean(),
    is_current: z.boolean(),
    is_next: z.boolean(),
    average_entry_score: z.number().nullable(),
    highest_score: z.number().nullable(),
  })
  .passthrough();

export const fplElementSchema = z
  .object({
    // Identity. `id` is season-scoped; `code` and `opta_code` are stable across
    // seasons, which is what R1.2 keys on.
    id: z.number().int(),
    code: z.number().int(),
    opta_code: z.string().nullable(),

    first_name: z.string(),
    second_name: z.string(),
    web_name: z.string(),

    element_type: z.number().int(),
    team: z.number().int(),
    team_code: z.number().int(),

    // Availability.
    status: z.string(),
    chance_of_playing_this_round: z.number().nullable(),
    chance_of_playing_next_round: z.number().nullable(),
    news: z.string(),
    news_added: z.string().nullable(),

    // Registration details. `squad_number` is declared by the API but null for
    // every player in the 25/26 dataset; `birth_date` is null for a handful.
    birth_date: z.string().nullable(),
    squad_number: z.number().int().nullable(),
    team_join_date: z.string().nullable(),

    now_cost: z.number().int(),
    selected_by_percent: decimalString,
    total_points: z.number().int(),

    // Season totals. Per-fixture truth comes from event/{gw}/live; these are
    // useful as a cross-check on the aggregates R2.3 recomputes.
    minutes: z.number().int(),
    starts: z.number().int(),
    goals_scored: z.number().int(),
    assists: z.number().int(),
    clean_sheets: z.number().int(),
    goals_conceded: z.number().int(),
    own_goals: z.number().int(),
    penalties_saved: z.number().int(),
    penalties_missed: z.number().int(),
    yellow_cards: z.number().int(),
    red_cards: z.number().int(),
    saves: z.number().int(),
    bonus: z.number().int(),
    bps: z.number().int(),
    tackles: z.number().int(),
    recoveries: z.number().int(),
    clearances_blocks_interceptions: z.number().int(),
    defensive_contribution: z.number().int(),
    influence: decimalString,
    creativity: decimalString,
    threat: decimalString,
    ict_index: decimalString,
    expected_goals: decimalString,
    expected_assists: decimalString,
    expected_goal_involvements: decimalString,
    expected_goals_conceded: decimalString,
  })
  .passthrough();

export const fplBootstrapStaticSchema = z
  .object({
    events: z.array(fplEventSchema),
    teams: z.array(fplTeamSchema),
    element_types: z.array(fplElementTypeSchema),
    elements: z.array(fplElementSchema),
    total_players: z.number().int(),
  })
  .passthrough();

// ---------------------------------------------------------------------- fixtures

export const fplFixtureStatSchema = z
  .object({
    identifier: z.string(),
    a: z.array(z.object({ value: z.number(), element: z.number().int() }).passthrough()),
    h: z.array(z.object({ value: z.number(), element: z.number().int() }).passthrough()),
  })
  .passthrough();

export const fplFixtureSchema = z
  .object({
    id: z.number().int(),
    code: z.number().int(),
    // Null on fixtures not yet assigned to a gameweek (postponements, and the
    // whole calendar in the window before a season is scheduled).
    event: z.number().int().nullable(),
    kickoff_time: z.string().nullable(),
    started: z.boolean().nullable(),
    finished: z.boolean(),
    finished_provisional: z.boolean(),
    provisional_start_time: z.boolean(),
    minutes: z.number().int(),
    team_h: z.number().int(),
    team_a: z.number().int(),
    team_h_score: z.number().int().nullable(),
    team_a_score: z.number().int().nullable(),
    team_h_difficulty: z.number().int(),
    team_a_difficulty: z.number().int(),
    stats: z.array(fplFixtureStatSchema),
  })
  .passthrough();

export const fplFixturesSchema = z.array(fplFixtureSchema);

// -------------------------------------------------------------- event/{gw}/live

export const fplLiveExplainStatSchema = z
  .object({
    identifier: z.string(),
    points: z.number().int(),
    value: z.number(),
  })
  .passthrough();

/**
 * One entry per fixture the player featured in during the gameweek. This is the
 * per-fixture attribution that makes double gameweeks correct — `stats` on the
 * element is the gameweek total, `explain` splits it by fixture.
 */
export const fplLiveExplainSchema = z
  .object({
    fixture: z.number().int(),
    stats: z.array(fplLiveExplainStatSchema),
  })
  .passthrough();

export const fplLiveStatsSchema = z
  .object({
    minutes: z.number().int(),
    starts: z.number().int(),
    goals_scored: z.number().int(),
    assists: z.number().int(),
    clean_sheets: z.number().int(),
    goals_conceded: z.number().int(),
    own_goals: z.number().int(),
    penalties_saved: z.number().int(),
    penalties_missed: z.number().int(),
    yellow_cards: z.number().int(),
    red_cards: z.number().int(),
    saves: z.number().int(),
    bonus: z.number().int(),
    bps: z.number().int(),
    tackles: z.number().int(),
    recoveries: z.number().int(),
    clearances_blocks_interceptions: z.number().int(),
    defensive_contribution: z.number().int(),
    influence: decimalString,
    creativity: decimalString,
    threat: decimalString,
    ict_index: decimalString,
    expected_goals: decimalString,
    expected_assists: decimalString,
    expected_goal_involvements: decimalString,
    expected_goals_conceded: decimalString,
    total_points: z.number().int(),
  })
  .passthrough();

export const fplLiveElementSchema = z
  .object({
    id: z.number().int(),
    stats: fplLiveStatsSchema,
    explain: z.array(fplLiveExplainSchema),
  })
  .passthrough();

export const fplEventLiveSchema = z
  .object({ elements: z.array(fplLiveElementSchema) })
  .passthrough();

// ------------------------------------------------------------------------- types

export type FplTeam = z.infer<typeof fplTeamSchema>;
export type FplElementType = z.infer<typeof fplElementTypeSchema>;
export type FplEvent = z.infer<typeof fplEventSchema>;
export type FplElement = z.infer<typeof fplElementSchema>;
export type FplBootstrapStatic = z.infer<typeof fplBootstrapStaticSchema>;
export type FplFixtureStat = z.infer<typeof fplFixtureStatSchema>;
export type FplFixture = z.infer<typeof fplFixtureSchema>;
export type FplLiveExplainStat = z.infer<typeof fplLiveExplainStatSchema>;
export type FplLiveExplain = z.infer<typeof fplLiveExplainSchema>;
export type FplLiveStats = z.infer<typeof fplLiveStatsSchema>;
export type FplLiveElement = z.infer<typeof fplLiveElementSchema>;
export type FplEventLive = z.infer<typeof fplEventLiveSchema>;
