// R1.5 archive adapters: the CSV reader, cell coercion, and the builders that
// turn the community archive back into the endpoint shapes the R1.2–R1.4
// pipeline already ingests. The full 38-gameweek backfill runs in
// scripts/backfill-2526.ts; these lock the transforms it depends on.

import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  buildBootstrapPayload,
  buildFixturesPayload,
  buildEventLivePlan,
} from '@/lib/ingest';
import type { CsvRow } from '@/lib/ingest';
import { parseBootstrapStatic, parseFixtures } from '@/lib/fpl';

describe('parseCsv', () => {
  it('parses a quoted field that contains commas and quotes', () => {
    const text = 'a,b,c\n1,"x, y, z",3\n4,"he said ""hi""",6\n';
    const rows = parseCsv(text);
    expect(rows).toEqual([
      { a: '1', b: 'x, y, z', c: '3' },
      { a: '4', b: 'he said "hi"', c: '6' },
    ]);
  });

  it('tolerates a missing trailing newline and blank lines', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([{ a: '1', b: '2' }]);
  });
});

// --- row factories: full rows with every column the schemas require --------

function teamRow(o: Partial<CsvRow> = {}): CsvRow {
  return {
    id: '1',
    code: '3',
    name: 'Arsenal',
    short_name: 'ARS',
    strength: '5',
    strength_overall_home: '1305',
    strength_overall_away: '1355',
    strength_attack_home: '1340',
    strength_attack_away: '1390',
    strength_defence_home: '1270',
    strength_defence_away: '1320',
    pulse_id: '1',
    ...o,
  };
}

function playerRow(o: Partial<CsvRow> = {}): CsvRow {
  const base: CsvRow = {
    id: '1',
    code: '154561',
    opta_code: 'p154561',
    first_name: 'David',
    second_name: 'Raya',
    web_name: 'Raya',
    element_type: '1',
    team: '1',
    team_code: '3',
    status: 'a',
    chance_of_playing_this_round: 'None',
    chance_of_playing_next_round: 'None',
    news: '',
    news_added: 'None',
    birth_date: '1995-09-15',
    squad_number: 'None',
    team_join_date: '2024-07-04',
    now_cost: '62',
    selected_by_percent: '36.4',
    total_points: '100',
    minutes: '3000',
    starts: '34',
    goals_scored: '0',
    assists: '0',
    clean_sheets: '13',
    goals_conceded: '30',
    own_goals: '0',
    penalties_saved: '1',
    penalties_missed: '0',
    yellow_cards: '2',
    red_cards: '0',
    saves: '80',
    bonus: '10',
    bps: '600',
    tackles: '5',
    recoveries: '120',
    clearances_blocks_interceptions: '40',
    defensive_contribution: '30',
    influence: '900.0',
    creativity: '50.0',
    threat: '20.0',
    ict_index: '97.0',
    expected_goals: '0.10',
    expected_assists: '0.50',
    expected_goal_involvements: '0.60',
    expected_goals_conceded: '35.00',
  };
  return { ...base, ...o } as CsvRow;
}

function gwRow(o: Partial<CsvRow> = {}): CsvRow {
  return {
    element: '67',
    fixture: '1',
    round: '1',
    minutes: '90',
    starts: '1',
    goals_scored: '0',
    assists: '0',
    clean_sheets: '0',
    goals_conceded: '1',
    own_goals: '0',
    penalties_saved: '0',
    penalties_missed: '0',
    yellow_cards: '0',
    red_cards: '0',
    saves: '3',
    bonus: '0',
    bps: '10',
    tackles: '0',
    recoveries: '2',
    clearances_blocks_interceptions: '1',
    defensive_contribution: '3',
    total_points: '2',
    expected_goals: '0.00',
    expected_assists: '0.00',
    expected_goal_involvements: '0.00',
    expected_goals_conceded: '1.50',
    influence: '20.0',
    creativity: '0.0',
    threat: '0.0',
    ict_index: '2.0',
    ...o,
  };
}

describe('buildBootstrapPayload', () => {
  it('reconstructs a payload that parses and stores null preseason strength', () => {
    const teams = [
      teamRow(),
      teamRow({
        id: '2',
        code: '4',
        name: 'Villa',
        short_name: 'AVL',
        strength: 'None',
        strength_overall_home: 'None',
      }),
    ];
    const players = [
      playerRow(),
      playerRow({
        id: '2',
        code: '111',
        opta_code: 'p111',
        web_name: 'X',
        team: '2',
        element_type: '4',
        squad_number: '9',
      }),
    ];
    const parsed = parseBootstrapStatic(buildBootstrapPayload(teams, players, [1, 2, 1]));

    expect(parsed.teams).toHaveLength(2);
    expect(parsed.teams[1].strength).toBeNull(); // "None" → null
    expect(parsed.events.map((e) => e.id)).toEqual([1, 2]); // deduped + sorted
    expect(parsed.events.every((e) => e.finished && e.data_checked)).toBe(true);
    // Nullable cells the archive writes as "None".
    expect(parsed.elements[0].squad_number).toBeNull();
    expect(parsed.elements[0].chance_of_playing_next_round).toBeNull();
    expect(parsed.elements[0].opta_code).toBe('p154561');
  });
});

describe('buildFixturesPayload', () => {
  it('reconstructs fixtures that parse, coercing Python booleans and None scores', () => {
    const rows: CsvRow[] = [
      {
        id: '1',
        code: '2561895',
        event: '1',
        kickoff_time: '2025-08-15T19:00:00Z',
        minutes: '90',
        started: 'True',
        finished: 'True',
        finished_provisional: 'True',
        provisional_start_time: 'False',
        team_h: '12',
        team_a: '4',
        team_h_score: '4',
        team_a_score: '2',
        team_h_difficulty: '3',
        team_a_difficulty: '4',
        stats: '[]',
      },
      {
        id: '2',
        code: '2561896',
        event: 'None',
        kickoff_time: 'None',
        minutes: '0',
        started: 'False',
        finished: 'False',
        finished_provisional: 'False',
        provisional_start_time: 'False',
        team_h: '1',
        team_a: '2',
        team_h_score: 'None',
        team_a_score: 'None',
        team_h_difficulty: '2',
        team_a_difficulty: '2',
        stats: '[]',
      },
    ];
    const parsed = parseFixtures(buildFixturesPayload(rows));
    expect(parsed[0]).toMatchObject({
      id: 1,
      event: 1,
      started: true,
      finished: true,
      team_h_score: 4,
    });
    expect(parsed[1]).toMatchObject({
      id: 2,
      event: null,
      kickoff_time: null,
      team_h_score: null,
      started: false,
    });
  });
});

describe('buildEventLivePlan', () => {
  it('splits a double gameweek and aggregates the model inputs to gameweek grain', () => {
    const rows = [
      gwRow({
        element: '67',
        fixture: '328',
        minutes: '90',
        total_points: '1',
        expected_goals: '0.10',
        bps: '9',
      }),
      gwRow({
        element: '67',
        fixture: '332',
        minutes: '90',
        total_points: '1',
        expected_goals: '0.20',
        bps: '5',
      }),
      gwRow({ element: '99', fixture: '328', minutes: '60', total_points: '2' }),
    ];
    const plan = buildEventLivePlan(rows);

    // Two fixture rows for the doubled player, one for the single.
    expect(
      plan.fixtureStats
        .filter((s) => s.playerFplId === 67)
        .map((s) => s.fixtureFplId)
        .sort(),
    ).toEqual([328, 332]);
    expect(plan.fixtureStats).toHaveLength(3);

    // One aggregated gameweek row per player; the double's inputs are summed.
    const gw = plan.gameweekStats.find((s) => s.playerFplId === 67)!;
    expect(gw.minutes).toBe(180);
    expect(gw.bps).toBe(14);
    expect(gw.expectedGoals).toBe('0.3'); // 0.10 + 0.20
    expect(plan.gameweekStats).toHaveLength(2);
  });

  it('collapses a byte-identical duplicate row without double-counting', () => {
    const row = gwRow({
      element: '100',
      fixture: '73',
      minutes: '74',
      total_points: '12',
      bps: '59',
    });
    const plan = buildEventLivePlan([row, { ...row }]);

    expect(plan.fixtureStats).toHaveLength(1);
    expect(plan.gameweekStats[0].minutes).toBe(74); // not 148
    expect(plan.warnings).toEqual([]);
  });

  it('warns and keeps the first when duplicate rows disagree', () => {
    const a = gwRow({ element: '100', fixture: '73', minutes: '74' });
    const b = gwRow({ element: '100', fixture: '73', minutes: '80' });
    const plan = buildEventLivePlan([a, b]);

    expect(plan.fixtureStats).toHaveLength(1);
    expect(plan.fixtureStats[0].minutes).toBe(74);
    expect(plan.warnings[0]).toContain('conflicting duplicate');
  });
});
