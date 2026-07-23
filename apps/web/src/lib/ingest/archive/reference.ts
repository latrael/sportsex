// Reconstruct the `bootstrap-static` and `fixtures` endpoint shapes from the
// archive CSVs, so the *exact same* pipeline the live API feeds — parse →
// plan → sync — ingests the 25/26 history. The archive is just those endpoints
// dumped to CSV; rebuilding the endpoint object and re-parsing it means the
// zod schemas re-validate every coercion, and 25/26 lands in identical shape
// to whatever 26/27 produces live.

import type { CsvRow } from './csv';
import type { FplBootstrapStatic, FplElement, FplFixture, FplTeam } from '@/lib/fpl';
import { bool, decimalStr, int, intOrNull, str, strOrNull } from './coerce';

/** FPL's four element types, keyed the way `singular_name_short` maps in R1.2. */
const ELEMENT_TYPES = [
  {
    id: 1,
    singular_name: 'Goalkeeper',
    singular_name_short: 'GKP',
    plural_name: 'Goalkeepers',
    plural_name_short: 'GKP',
    element_count: 0,
  },
  {
    id: 2,
    singular_name: 'Defender',
    singular_name_short: 'DEF',
    plural_name: 'Defenders',
    plural_name_short: 'DEF',
    element_count: 0,
  },
  {
    id: 3,
    singular_name: 'Midfielder',
    singular_name_short: 'MID',
    plural_name: 'Midfielders',
    plural_name_short: 'MID',
    element_count: 0,
  },
  {
    id: 4,
    singular_name: 'Forward',
    singular_name_short: 'FWD',
    plural_name: 'Forwards',
    plural_name_short: 'FWD',
    element_count: 0,
  },
];

function team(row: CsvRow): FplTeam {
  return {
    id: int(row.id, 'team.id'),
    code: int(row.code, 'team.code'),
    name: str(row.name),
    short_name: str(row.short_name),
    strength: intOrNull(row.strength),
    strength_overall_home: intOrNull(row.strength_overall_home),
    strength_overall_away: intOrNull(row.strength_overall_away),
    strength_attack_home: intOrNull(row.strength_attack_home),
    strength_attack_away: intOrNull(row.strength_attack_away),
    strength_defence_home: intOrNull(row.strength_defence_home),
    strength_defence_away: intOrNull(row.strength_defence_away),
    pulse_id: int(row.pulse_id, 'team.pulse_id'),
  };
}

function element(row: CsvRow): FplElement {
  return {
    id: int(row.id, 'element.id'),
    code: int(row.code, 'element.code'),
    opta_code: strOrNull(row.opta_code),
    first_name: str(row.first_name),
    second_name: str(row.second_name),
    web_name: str(row.web_name),
    element_type: int(row.element_type, 'element.element_type'),
    team: int(row.team, 'element.team'),
    team_code: int(row.team_code, 'element.team_code'),
    status: str(row.status),
    chance_of_playing_this_round: intOrNull(row.chance_of_playing_this_round),
    chance_of_playing_next_round: intOrNull(row.chance_of_playing_next_round),
    news: str(row.news),
    news_added: strOrNull(row.news_added),
    birth_date: strOrNull(row.birth_date),
    squad_number: intOrNull(row.squad_number),
    team_join_date: strOrNull(row.team_join_date),
    now_cost: int(row.now_cost, 'element.now_cost'),
    selected_by_percent: decimalStr(row.selected_by_percent),
    total_points: int(row.total_points, 'element.total_points'),
    minutes: int(row.minutes, 'element.minutes'),
    starts: int(row.starts, 'element.starts'),
    goals_scored: int(row.goals_scored, 'element.goals_scored'),
    assists: int(row.assists, 'element.assists'),
    clean_sheets: int(row.clean_sheets, 'element.clean_sheets'),
    goals_conceded: int(row.goals_conceded, 'element.goals_conceded'),
    own_goals: int(row.own_goals, 'element.own_goals'),
    penalties_saved: int(row.penalties_saved, 'element.penalties_saved'),
    penalties_missed: int(row.penalties_missed, 'element.penalties_missed'),
    yellow_cards: int(row.yellow_cards, 'element.yellow_cards'),
    red_cards: int(row.red_cards, 'element.red_cards'),
    saves: int(row.saves, 'element.saves'),
    bonus: int(row.bonus, 'element.bonus'),
    bps: int(row.bps, 'element.bps'),
    tackles: int(row.tackles, 'element.tackles'),
    recoveries: int(row.recoveries, 'element.recoveries'),
    clearances_blocks_interceptions: int(row.clearances_blocks_interceptions, 'element.cbi'),
    defensive_contribution: int(row.defensive_contribution, 'element.defensive_contribution'),
    influence: decimalStr(row.influence),
    creativity: decimalStr(row.creativity),
    threat: decimalStr(row.threat),
    ict_index: decimalStr(row.ict_index),
    expected_goals: decimalStr(row.expected_goals),
    expected_assists: decimalStr(row.expected_assists),
    expected_goal_involvements: decimalStr(row.expected_goal_involvements),
    expected_goals_conceded: decimalStr(row.expected_goals_conceded),
  };
}

/**
 * Build a `bootstrap-static` payload from teams.csv + players_raw.csv. The
 * events (gameweeks) aren't dumped by the archive, so they're synthesised from
 * the fixture calendar's gameweek numbers — a completed season, so every one is
 * finished and data-checked. Deadlines aren't in the archive and aren't used
 * downstream, so they stay null.
 */
export function buildBootstrapPayload(
  teams: CsvRow[],
  players: CsvRow[],
  gameweekNumbers: number[],
): FplBootstrapStatic {
  const events = [...new Set(gameweekNumbers)]
    .sort((a, b) => a - b)
    .map((n) => ({
      id: n,
      name: `Gameweek ${n}`,
      deadline_time: null,
      finished: true,
      data_checked: true,
      is_previous: false,
      is_current: false,
      is_next: false,
      average_entry_score: null,
      highest_score: null,
    }));

  return {
    events,
    teams: teams.map(team),
    element_types: ELEMENT_TYPES,
    elements: players.map(element),
    total_players: players.length,
  } as FplBootstrapStatic;
}

export function buildFixturesPayload(fixtures: CsvRow[]): FplFixture[] {
  return fixtures.map((row) => ({
    id: int(row.id, 'fixture.id'),
    code: int(row.code, 'fixture.code'),
    event: intOrNull(row.event),
    kickoff_time: strOrNull(row.kickoff_time),
    started: bool(row.started),
    finished: bool(row.finished),
    finished_provisional: bool(row.finished_provisional),
    provisional_start_time: bool(row.provisional_start_time),
    minutes: int(row.minutes, 'fixture.minutes'),
    team_h: int(row.team_h, 'fixture.team_h'),
    team_a: int(row.team_a, 'fixture.team_a'),
    team_h_score: intOrNull(row.team_h_score),
    team_a_score: intOrNull(row.team_a_score),
    team_h_difficulty: int(row.team_h_difficulty, 'fixture.team_h_difficulty'),
    team_a_difficulty: int(row.team_a_difficulty, 'fixture.team_a_difficulty'),
    // The per-fixture stats blob is in the CSV but our fixture ingest (R1.3)
    // doesn't store it; the per-player truth comes from the gws files instead.
    stats: [],
  }));
}
