import { randomUUID } from 'crypto';

/**
 * R7.4 — Observability & Sentry reporting for app and cron paths.
 *
 * Forwards errors and invariant-drift alerts to Sentry when `SENTRY_DSN` is
 * configured (`https://<key>@<host>/<projectId>`), and records structured events
 * in an in-memory ring buffer so reconciliation and cron tests can assert alert
 * delivery deterministically without external network dependencies.
 */

export type AlertSeverity = 'error' | 'warning' | 'critical';

export interface CapturedAlertEvent {
  id: string;
  timestamp: string;
  severity: AlertSeverity;
  source: string;
  title: string;
  details: Record<string, unknown>;
}

const MAX_BUFFER_EVENTS = 200;
const capturedEvents: CapturedAlertEvent[] = [];

export function getCapturedAlerts(): readonly CapturedAlertEvent[] {
  return capturedEvents;
}

export function clearCapturedAlerts(): void {
  capturedEvents.length = 0;
}

function parseSentryDsn(dsn: string): { storeUrl: string; publicKey: string } | null {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\/+/, '');
    if (!publicKey || !projectId) return null;
    const storeUrl = `${url.protocol}//${url.host}/api/${projectId}/store/`;
    return { storeUrl, publicKey };
  } catch {
    return null;
  }
}

async function sendToSentryIfConfigured(
  event: CapturedAlertEvent,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  const parsed = parseSentryDsn(dsn);
  if (!parsed) return false;

  try {
    const res = await fetchImpl(parsed.storeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=sportsex/1.0`,
      },
      body: JSON.stringify({
        event_id: event.id.replace(/-/g, ''),
        timestamp: event.timestamp,
        level: event.severity === 'critical' ? 'fatal' : event.severity,
        logger: event.source,
        message: event.title,
        extra: event.details,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function captureAlert(input: {
  source: string;
  title: string;
  severity?: AlertSeverity;
  details?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<CapturedAlertEvent> {
  const event: CapturedAlertEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    severity: input.severity ?? 'critical',
    source: input.source,
    title: input.title,
    details: input.details ?? {},
  };

  capturedEvents.push(event);
  if (capturedEvents.length > MAX_BUFFER_EVENTS) {
    capturedEvents.shift();
  }

  await sendToSentryIfConfigured(event, input.fetchImpl);
  return event;
}

export async function captureException(
  error: unknown,
  context: {
    source: string;
    details?: Record<string, unknown>;
    fetchImpl?: typeof fetch;
  },
): Promise<CapturedAlertEvent> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  return captureAlert({
    source: context.source,
    title: message,
    severity: 'error',
    details: {
      ...context.details,
      stack,
    },
    fetchImpl: context.fetchImpl,
  });
}
