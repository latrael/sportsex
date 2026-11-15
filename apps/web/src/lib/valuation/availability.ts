/**
 * R3.4 — Availability multiplier (`M_p`):
 *
 * Formula (REBUILD_PLAN §"The algorithm" d):
 *   M_p = expected_minutes_share × availability_factor
 *     - expected_minutes_share: EWMA of minutes/90 over last 6 team fixtures
 *       (half-life = 3 fixtures), blended with season starts rate (`starts / teamFixtures`).
 *     - availability_factor: from FPL `status` and `chance_of_playing_next_round`
 *       (`a` = 1.0, `d` = clamp(chance/100, 0.25, 0.75), `i`/`s`/`u`/`n` → 0.15 floor).
 *
 * Behavior (R3.4 acceptance criteria):
 *   1. A player who stops appearing (`minutes = 0` over subsequent gameweeks) decays
 *      smoothly toward the floor over ~6 gameweeks.
 *   2. A player whose FPL `status` flips to `'i'` (injured) or `'s'` (suspended)
 *      drops immediately via `availability_factor = 0.15`.
 */

import { VALUATION_PARAMS } from './config';

export interface RecentFixturePresence {
  /** Chronological fixture/gameweek order (oldest to newest). */
  order: number;
  /** Minutes played in this fixture/gameweek (0 if unused sub / not in squad). */
  minutes: number;
  /** Starts in this fixture/gameweek (0 or 1; up to 2 in a double gameweek). */
  starts?: number;
}

export interface AvailabilityInput {
  /**
   * Recent team fixtures up to the evaluation point (including 0-minute weeks
   * where the player's club played but the player did not appear).
   */
  recentFixtures: readonly RecentFixturePresence[];
  /** Total starts across the season up to this point. */
  seasonStarts?: number;
  /** Total fixtures the player's club has played across the season up to this point. */
  seasonTeamFixtures?: number;
  /** FPL status code: 'a' | 'd' | 'i' | 's' | 'u' | 'n'. Defaults to 'a'. */
  status?: string | null;
  /** FPL chance_of_playing_next_round (0..100 or null). */
  chanceOfPlayingNextRound?: number | null;
}

export interface AvailabilityResult {
  expectedMinutesShare: number;
  availabilityFactor: number;
  multiplier: number;
}

/**
 * Compute FPL status / chance-of-playing factor:
 *   - `'a'` (available): 1.0 (or `chance / 100` if explicitly set < 100)
 *   - `'d'` (doubtful): `chance / 100` if present (floored at 0.15), else 0.5
 *   - `'i'` | `'s'` | `'u'` | `'n'` (injured / suspended / unavailable / not in squad): 0.15 floor
 */
export function computeStatusFactor(
  status?: string | null,
  chanceOfPlayingNextRound?: number | null,
): number {
  const floor = VALUATION_PARAMS.unavailableFloor;
  const code = (status ?? 'a').toLowerCase().trim();

  if (code === 'i' || code === 's' || code === 'u' || code === 'n') {
    return floor;
  }

  if (code === 'd') {
    if (chanceOfPlayingNextRound != null && Number.isFinite(chanceOfPlayingNextRound)) {
      return Math.max(floor, Math.min(1.0, chanceOfPlayingNextRound / 100));
    }
    return 0.5;
  }

  // 'a' or unknown default
  if (
    chanceOfPlayingNextRound != null &&
    Number.isFinite(chanceOfPlayingNextRound) &&
    chanceOfPlayingNextRound < 100
  ) {
    return Math.max(floor, Math.min(1.0, chanceOfPlayingNextRound / 100));
  }
  return 1.0;
}

/**
 * Compute `M_p = expected_minutes_share × availability_factor`, bounded to
 * `[minPlayableMinutesFloor, 1.0]`.
 */
export function computeAvailabilityMultiplier(input: AvailabilityInput): AvailabilityResult {
  const windowSize = VALUATION_PARAMS.minutesWindow;
  const halfLife = VALUATION_PARAMS.minutesHalfLife;
  const minFloor = VALUATION_PARAMS.minPlayableMinutesFloor;

  const sorted = [...input.recentFixtures].sort((a, b) => a.order - b.order);
  const window = sorted.slice(-windowSize);

  let ewmaShare = 0;
  if (window.length > 0) {
    let wSum = 0;
    let wTotal = 0;
    const n = window.length;
    for (let i = 0; i < n; i++) {
      const ago = n - 1 - i;
      const w = Math.pow(0.5, ago / halfLife);
      const share = Math.max(0, Math.min(1, window[i].minutes / 90));
      wSum += w * share;
      wTotal += w;
    }
    ewmaShare = wTotal > 0 ? wSum / wTotal : 0;
  }

  // Starts rate over recent window or season
  let startsRate = ewmaShare;
  if (window.length > 0) {
    const windowStarts = window.reduce(
      (acc, f) => acc + (f.starts !== undefined ? Math.min(1, f.starts) : f.minutes >= 60 ? 1 : 0),
      0,
    );
    const recentStartsRate = Math.min(1, windowStarts / window.length);

    if (
      input.seasonTeamFixtures !== undefined &&
      input.seasonTeamFixtures > 0 &&
      input.seasonStarts !== undefined
    ) {
      const seasonRate = Math.min(1, input.seasonStarts / input.seasonTeamFixtures);
      // Weight recent window starts more heavily so a player who loses their place
      // decays toward the floor over ~6 GWs instead of being propped up by early-season starts.
      startsRate = 0.75 * recentStartsRate + 0.25 * seasonRate;
    } else {
      startsRate = recentStartsRate;
    }
  }

  const rawMinutesShare = 0.75 * ewmaShare + 0.25 * startsRate;
  const expectedMinutesShare = Math.max(minFloor, Math.min(1.0, rawMinutesShare));
  const availabilityFactor = computeStatusFactor(input.status, input.chanceOfPlayingNextRound);
  const multiplier = Math.max(
    minFloor,
    Math.min(1.0, expectedMinutesShare * availabilityFactor),
  );

  return {
    expectedMinutesShare,
    availabilityFactor,
    multiplier,
  };
}
