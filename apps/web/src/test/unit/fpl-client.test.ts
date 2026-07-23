// Client behaviour: URLs, headers, retry policy, and raw retention.
// fetch is stubbed throughout — no network, no real sleeping.

import { describe, it, expect, vi } from 'vitest';
import {
  FplClient,
  FplHttpError,
  FplNetworkError,
  FplParseError,
  FPL_BASE_URL,
  parseByEndpoint,
  parseRetryAfter,
  type RawPayload,
} from '@/lib/fpl';
import bootstrapSample from '../fixtures/fpl/bootstrap-static.sample.json';
import fixturesSample from '../fixtures/fpl/fixtures.sample.json';
import live33Sample from '../fixtures/fpl/event-33-live.sample.json';

type Step = Response | Error;

/** A fetch that plays back a scripted sequence and records what it was called with. */
function stubFetch(steps: Step[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** No real time passes in these tests; record what we would have slept. */
function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

function client(steps: Step[], overrides: Partial<ConstructorParameters<typeof FplClient>[0]> = {}) {
  const fetchStub = stubFetch(steps);
  const timing = recorder();
  const fpl = new FplClient({
    fetchImpl: fetchStub.impl,
    sleep: timing.sleep,
    random: () => 0.5,
    ...overrides,
  });
  return { fpl, calls: fetchStub.calls, slept: timing.slept };
}

describe('endpoints', () => {
  it('requests bootstrap-static and returns typed data', async () => {
    const { fpl, calls } = client([json(bootstrapSample)]);
    const { data } = await fpl.bootstrapStatic();

    expect(calls[0].url).toBe(`${FPL_BASE_URL}/bootstrap-static/`);
    expect(data.teams).toHaveLength(9);
    expect(data.elements.find((e) => e.id === 381)?.web_name).toBe('M.Salah');
  });

  it('requests all fixtures, or one gameweek', async () => {
    const all = client([json(fixturesSample)]);
    const { data } = await all.fpl.fixtures();
    expect(all.calls[0].url).toBe(`${FPL_BASE_URL}/fixtures/`);
    expect(data.some((f) => f.id === 1)).toBe(true);

    const single = client([json(fixturesSample)]);
    await single.fpl.fixtures({ event: 33 });
    expect(single.calls[0].url).toBe(`${FPL_BASE_URL}/fixtures/?event=33`);
  });

  it('requests a gameweek live feed', async () => {
    const { fpl, calls } = client([json(live33Sample)]);
    const { data } = await fpl.eventLive(33);
    expect(calls[0].url).toBe(`${FPL_BASE_URL}/event/33/live/`);
    expect(data.elements.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-range gameweek without touching the network', async () => {
    const { fpl, calls } = client([json(live33Sample)]);
    await expect(fpl.eventLive(0)).rejects.toThrow(RangeError);
    await expect(fpl.eventLive(39)).rejects.toThrow(RangeError);
    await expect(fpl.eventLive(1.5)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('sends an identifying User-Agent', async () => {
    const { fpl, calls } = client([json(bootstrapSample)]);
    await fpl.bootstrapStatic();
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toMatch(/sportsex/);
    expect(headers.Accept).toBe('application/json');
  });

  it('honours a custom base URL and User-Agent', async () => {
    const { fpl, calls } = client([json(fixturesSample)], {
      baseUrl: 'https://mirror.example/api/',
      userAgent: 'test-agent/9',
    });
    await fpl.fixtures();
    expect(calls[0].url).toBe('https://mirror.example/api/fixtures/');
    expect((calls[0].init?.headers as Record<string, string>)['User-Agent']).toBe('test-agent/9');
  });
});

describe('raw retention', () => {
  it('returns the raw payload alongside the parsed data', async () => {
    const { fpl } = client([json(bootstrapSample)]);
    const { raw } = await fpl.bootstrapStatic();

    expect(raw.endpoint).toBe('bootstrap-static');
    expect(raw.url).toBe(`${FPL_BASE_URL}/bootstrap-static/`);
    expect(raw.status).toBe(200);
    expect(raw.attempts).toBe(1);
    expect(raw.bytes).toBe(Buffer.byteLength(JSON.stringify(bootstrapSample), 'utf8'));
    expect(raw.body).toEqual(bootstrapSample);
    expect(Number.isNaN(Date.parse(raw.fetchedAt))).toBe(false);
  });

  it('hands every payload to the archive hook before parsing', async () => {
    const archive: RawPayload[] = [];
    const { fpl } = client([json(live33Sample)], { onRaw: (raw) => void archive.push(raw) });
    await fpl.eventLive(33);
    expect(archive).toHaveLength(1);
    expect(archive[0].endpoint).toBe('event-live');
  });

  it('archives payloads that then fail to parse, so the failure is debuggable', async () => {
    const archive: RawPayload[] = [];
    const { fpl } = client([json({ elements: [{ id: 1 }] })], {
      onRaw: (raw) => void archive.push(raw),
    });
    await expect(fpl.eventLive(33)).rejects.toThrow(FplParseError);
    expect(archive).toHaveLength(1);
    expect(archive[0].body).toEqual({ elements: [{ id: 1 }] });
  });

  it('replays an archived payload with no further fetches', async () => {
    const archive: RawPayload[] = [];
    const { fpl, calls } = client([json(fixturesSample)], {
      onRaw: (raw) => void archive.push(raw),
    });
    const { data } = await fpl.fixtures();
    expect(calls).toHaveLength(1);

    const replayed = parseByEndpoint(archive[0].endpoint, archive[0].body);
    expect(replayed).toEqual(data);
    expect(calls).toHaveLength(1);
  });
});

describe('retry policy', () => {
  it('retries a 503 and reports the attempt count', async () => {
    const { fpl, calls, slept } = client([
      new Response('busy', { status: 503 }),
      json(fixturesSample),
    ]);
    const { raw } = await fpl.fixtures();
    expect(calls).toHaveLength(2);
    expect(raw.attempts).toBe(2);
    expect(slept).toEqual([250]); // full jitter: 0.5 × (500 × 2⁰)
  });

  it('retries a transport error', async () => {
    const { fpl, calls } = client([new TypeError('fetch failed'), json(fixturesSample)]);
    await expect(fpl.fixtures()).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('retries a truncated body that is not valid JSON', async () => {
    const { fpl, calls } = client([
      new Response('{"elements":[', { status: 200 }),
      json(live33Sample),
    ]);
    await expect(fpl.eventLive(33)).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('backs off exponentially, capped at maxDelayMs', async () => {
    const { fpl, slept } = client(
      [
        new Response('', { status: 500 }),
        new Response('', { status: 500 }),
        new Response('', { status: 500 }),
        new Response('', { status: 500 }),
        json(fixturesSample),
      ],
      { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 4000 },
    );
    await fpl.fixtures();
    expect(slept).toEqual([500, 1000, 2000, 2000]); // 0.5 × [1000, 2000, 4000, 4000]
  });

  it('waits out a Retry-After header instead of its own backoff', async () => {
    const { fpl, slept } = client([
      new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
      json(fixturesSample),
    ]);
    await fpl.fixtures();
    expect(slept).toEqual([3000]);
  });

  it('gives up rather than waiting out an excessive Retry-After', async () => {
    const { fpl, calls, slept } = client(
      [new Response('', { status: 429, headers: { 'retry-after': '600' } }), json(fixturesSample)],
      { maxRetryAfterMs: 60_000 },
    );
    await expect(fpl.fixtures()).rejects.toThrow(FplHttpError);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it('does not retry a 404', async () => {
    const { fpl, calls } = client([new Response('not found', { status: 404 })]);
    await expect(fpl.eventLive(38)).rejects.toMatchObject({
      name: 'FplHttpError',
      status: 404,
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it('throws FplHttpError once retries are exhausted', async () => {
    const { fpl, calls } = client([new Response('', { status: 502 })], { maxAttempts: 3 });
    await expect(fpl.fixtures()).rejects.toMatchObject({ name: 'FplHttpError', status: 502 });
    expect(calls).toHaveLength(3);
  });

  it('throws FplNetworkError when every attempt fails at the transport', async () => {
    const { fpl, calls } = client([new TypeError('fetch failed')], { maxAttempts: 2 });
    await expect(fpl.fixtures()).rejects.toThrow(FplNetworkError);
    expect(calls).toHaveLength(2);
  });

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fpl, calls } = client([json(fixturesSample)]);
    await expect(fpl.fixtures({ signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-07-22T12:00:00Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Wed, 22 Jul 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  it('clamps a date in the past to zero', () => {
    expect(parseRetryAfter('Wed, 22 Jul 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns null for a missing or unparseable header', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });
});
