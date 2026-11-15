// Derived layer: everything computed *from* the immutable event rows rather
// than written alongside them. Season aggregates land here in R2.3; fair value
// (R3.x) is the next tenant.

export {
  SeasonStatsPlanError,
  planSeasonStats,
  type FixtureStatRow,
  type GameweekStatRow,
  type PlannedSeasonStat,
  type SeasonStatsPlan,
} from './seasonStats/plan';

export {
  SeasonStatsSyncError,
  recomputeSeasonStats,
  type SeasonStatsSyncResult,
} from './seasonStats/sync';
