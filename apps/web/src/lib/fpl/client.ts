// Typed client for the three FPL endpoints the ingestion pipeline reads.
//
// No API key, no documented rate limit, but it is someone else's unversioned
// endpoint: identify ourselves honestly, back off when asked, and keep the raw
// bytes of every successful response so a parse can be replayed without going
// back over the network.

import {
  FplParseError,
  parseBootstrapStatic,
  parseEventLive,
  parseFixtures,
  type FplEndpoint,
} from './parse';
import type { FplBootstrapStatic, FplEventLive, FplFixture } from './types';

export const FPL_BASE_URL = 'https://fantasy.premierleague.com/api';

const DEFAULT_USER_AGENT =
  'sportsex/1.0 (+https://github.com/sportsex; contact: djaber.nab@gmail.com)';

/** What was fetched, retained verbatim so any parse can be replayed later. */
export type RawPayload = {
  endpoint: FplEndpoint;
  url: string;
  status: number;
  /** ISO timestamp of the response that was accepted. */
  fetchedAt: string;
  /** Byte length of the response body as received. */
  bytes: number;
  /** How many requests it took, including the one that succeeded. */
  attempts: number;
  durationMs: number;
  /** The response body parsed as JSON and otherwise untouched. */
  body: unknown;
};

export type FplResult<T> = { data: T; raw: RawPayload };

export type FplClientOptions = {
  baseUrl?: string;
  userAgent?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Total attempts per request, including the first. Default 4. */
  maxAttempts?: number;
  /** Base backoff in ms. Default 500. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 8000. */
  maxDelayMs?: number;
  /** Per-attempt timeout in ms. Default 20000. */
  timeoutMs?: number;
  /** Longest `Retry-After` we will wait out before giving up. Default 60000. */
  maxRetryAfterMs?: number;
  /** Full-jitter source in [0, 1). Injectable so backoff is deterministic in tests. */
  random?: () => number;
  /** Injectable sleep, so tests don't spend real seconds backing off. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called with every successful raw payload before it is parsed. This is the
   * archive hook: point it at blob storage or a `raw_payload` table and every
   * ingest becomes replayable.
   */
  onRaw?: (raw: RawPayload) => void | Promise<void>;
};

export type FplRequestOptions = {
  /** Caller-side cancellation; independent of the per-attempt timeout. */
  signal?: AbortSignal;
};

/** An HTTP-level failure, thrown after retries are exhausted or on a hard 4xx. */
export class FplHttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly attempts: number;
  readonly bodyPreview: string;

  constructor(url: string, status: number, attempts: number, bodyPreview: string) {
    super(`FPL request failed: ${status} for ${url} after ${attempts} attempt(s)`);
    this.name = 'FplHttpError';
    this.url = url;
    this.status = status;
    this.attempts = attempts;
    this.bodyPreview = bodyPreview;
  }
}

/** A transport or malformed-body failure that survived every retry. */
export class FplNetworkError extends Error {
  readonly url: string;
  readonly attempts: number;

  constructor(url: string, attempts: number, cause: unknown) {
    super(
      `FPL request to ${url} failed after ${attempts} attempt(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'FplNetworkError';
    this.url = url;
    this.attempts = attempts;
    this.cause = cause;
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Returns null when the
 * header is absent or unparseable, in which case normal backoff applies.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export class FplClient {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRaw?: (raw: RawPayload) => void | Promise<void>;

  constructor(options: FplClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? FPL_BASE_URL).replace(/\/+$/, '');
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 8_000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.onRaw = options.onRaw;
  }

  async bootstrapStatic(options: FplRequestOptions = {}): Promise<FplResult<FplBootstrapStatic>> {
    const raw = await this.getJson('bootstrap-static', '/bootstrap-static/', options);
    return { data: parseBootstrapStatic(raw.body), raw };
  }

  /** All 380 fixtures, or one gameweek's when `event` is given. */
  async fixtures(
    options: FplRequestOptions & { event?: number } = {},
  ): Promise<FplResult<FplFixture[]>> {
    const path = options.event === undefined ? '/fixtures/' : `/fixtures/?event=${options.event}`;
    const raw = await this.getJson('fixtures', path, options);
    return { data: parseFixtures(raw.body), raw };
  }

  /** Per-player stats for a gameweek, with per-fixture attribution in `explain`. */
  async eventLive(
    gameweek: number,
    options: FplRequestOptions = {},
  ): Promise<FplResult<FplEventLive>> {
    if (!Number.isInteger(gameweek) || gameweek < 1 || gameweek > 38) {
      throw new RangeError(`gameweek must be an integer in 1..38, got ${gameweek}`);
    }
    const raw = await this.getJson('event-live', `/event/${gameweek}/live/`, options);
    return { data: parseEventLive(raw.body), raw };
  }

  /** Fetch with retry, returning the raw payload record. Does not validate shape. */
  private async getJson(
    endpoint: FplEndpoint,
    path: string,
    { signal }: FplRequestOptions,
  ): Promise<RawPayload> {
    const url = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      signal?.throwIfAborted();

      let response: Response;
      try {
        response = await this.fetchOnce(url, signal);
      } catch (error) {
        // A caller-initiated abort is a decision, not a failure to retry through.
        if (signal?.aborted) throw error;
        lastError = error;
        if (attempt === this.maxAttempts) break;
        await this.backoff(attempt, null);
        continue;
      }

      if (!response.ok) {
        const bodyPreview = (await safeText(response)).slice(0, 200);
        const retryable = RETRYABLE_STATUSES.has(response.status);
        if (!retryable || attempt === this.maxAttempts) {
          throw new FplHttpError(url, response.status, attempt, bodyPreview);
        }
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (retryAfter !== null && retryAfter > this.maxRetryAfterMs) {
          throw new FplHttpError(url, response.status, attempt, bodyPreview);
        }
        await this.backoff(attempt, retryAfter);
        continue;
      }

      // Read as text first: a truncated body is a transport problem worth
      // retrying, and it gives us an exact byte count for the archive record.
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        if (attempt === this.maxAttempts) break;
        await this.backoff(attempt, null);
        continue;
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxAttempts) break;
        await this.backoff(attempt, null);
        continue;
      }

      const raw: RawPayload = {
        endpoint,
        url,
        status: response.status,
        fetchedAt: new Date().toISOString(),
        bytes: byteLength(text),
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        body,
      };
      await this.onRaw?.(raw);
      return raw;
    }

    throw new FplNetworkError(url, this.maxAttempts, lastError);
  }

  private async fetchOnce(url: string, signal: AbortSignal | undefined): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`FPL request timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    try {
      return await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Full jitter: sleep uniformly in [0, min(maxDelay, base·2^(n-1))). */
  private async backoff(attempt: number, retryAfterMs: number | null): Promise<void> {
    if (retryAfterMs !== null) {
      await this.sleep(retryAfterMs);
      return;
    }
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    await this.sleep(Math.floor(this.random() * ceiling));
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function byteLength(text: string): number {
  return typeof Buffer !== 'undefined'
    ? Buffer.byteLength(text, 'utf8')
    : new TextEncoder().encode(text).length;
}

export { FplParseError };
