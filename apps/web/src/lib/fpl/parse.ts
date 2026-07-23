// Parsing is separate from fetching on purpose: every parse takes plain
// `unknown` JSON, so a payload archived by the client (or dumped from the DB by
// a later ingestion job) can be re-parsed with new code and no network call.

import type { ZodIssue, ZodType } from 'zod';
import {
  fplBootstrapStaticSchema,
  fplEventLiveSchema,
  fplFixturesSchema,
  type FplBootstrapStatic,
  type FplEventLive,
  type FplFixture,
} from './types';

export type FplEndpoint = 'bootstrap-static' | 'fixtures' | 'event-live';

/** Thrown when a payload parses as JSON but doesn't match the expected shape. */
export class FplParseError extends Error {
  readonly endpoint: FplEndpoint;
  readonly issues: ZodIssue[];
  /** The payload that failed, so the caller can archive it and debug offline. */
  readonly raw: unknown;

  constructor(endpoint: FplEndpoint, issues: ZodIssue[], raw: unknown) {
    const detail = issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : '';
    super(`FPL ${endpoint} payload did not match the expected shape — ${detail}${more}`);
    this.name = 'FplParseError';
    this.endpoint = endpoint;
    this.issues = issues;
    this.raw = raw;
  }
}

function parseWith<T>(endpoint: FplEndpoint, schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new FplParseError(endpoint, result.error.issues, raw);
  return result.data;
}

export function parseBootstrapStatic(raw: unknown): FplBootstrapStatic {
  return parseWith('bootstrap-static', fplBootstrapStaticSchema, raw);
}

export function parseFixtures(raw: unknown): FplFixture[] {
  return parseWith('fixtures', fplFixturesSchema, raw);
}

export function parseEventLive(raw: unknown): FplEventLive {
  return parseWith('event-live', fplEventLiveSchema, raw);
}

/**
 * Re-parse an archived payload. Dispatches on the endpoint recorded at fetch
 * time, so replaying a stored `RawPayload` is a one-liner with no network.
 */
export function parseByEndpoint(endpoint: FplEndpoint, raw: unknown): unknown {
  switch (endpoint) {
    case 'bootstrap-static':
      return parseBootstrapStatic(raw);
    case 'fixtures':
      return parseFixtures(raw);
    case 'event-live':
      return parseEventLive(raw);
    default: {
      const exhaustive: never = endpoint;
      throw new Error(`Unknown FPL endpoint: ${String(exhaustive)}`);
    }
  }
}
