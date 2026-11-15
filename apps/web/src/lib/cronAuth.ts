import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';

/**
 * R6.5 — Hardened cron authentication.
 *
 * Fails closed:
 * - If `CRON_SECRET` is unset, empty, or whitespace-only -> 503 Service Unavailable (misconfigured).
 * - If `Authorization` header is missing, not `Bearer <token>`, or does not match `CRON_SECRET`
 *   in constant time -> 401 Unauthorized.
 * - Returns `null` when the request is authenticated and allowed to proceed.
 */
export function verifyCronRequest(
  req: Request,
  ...secretOverride: [string | undefined] | []
): NextResponse | null {
  const rawSecret = secretOverride.length > 0 ? secretOverride[0] : process.env.CRON_SECRET;
  const secret = rawSecret?.trim();
  if (!secret || secret.length < 8) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured' },
      { status: 503 },
    );
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Missing or malformed Authorization header' },
      { status: 401 },
    );
  }

  const provided = authHeader.slice('Bearer '.length);
  const expectedBuf = Buffer.from(secret, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');

  if (
    expectedBuf.byteLength !== providedBuf.byteLength ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    return NextResponse.json(
      { error: 'Invalid cron secret' },
      { status: 401 },
    );
  }

  return null;
}
