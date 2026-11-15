export {
  POSITION_WEIGHTS,
  POSITION_BASE_PRICE,
  VALUATION_PARAMS,
  type PositionWeights,
} from './config';

export {
  computeRawPerformance,
  scorePerformanceCohort,
  type PerformanceStatInput,
  type RawPerformanceBreakdown,
  type ScoredPerformance,
  type CohortStats,
} from './performance';

export { computeFormEwma, type FormObservation } from './form';

export {
  computeBaselineShrinkage,
  computeCohortMedianPriors,
  type BaselineInput,
} from './baseline';

export {
  computeStatusFactor,
  computeAvailabilityMultiplier,
  type RecentFixturePresence,
  type AvailabilityInput,
  type AvailabilityResult,
} from './availability';

export {
  fairValue,
  clubFairValue,
  type FairValueCompositionInput,
  type FairValueCompositionResult,
  type ClubFairValueInput,
} from './fairValue';

export {
  evaluateLeagueAtGameweek,
  type PlayerValuationMetadata,
  type EvaluatedPlayerValuation,
  type EvaluateGameweekInput,
} from './engine';

export {
  syncSeasonFairValues,
  type SyncFairValuesOptions,
  type SyncFairValuesResult,
} from './sync';
