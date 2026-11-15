import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { RawPayload } from '@/lib/fpl';
import type { RawPayloadOutcome } from './live/sync';

/**
 * Archive a raw FPL response in `raw_payload` keyed on `(endpoint, scopeKey)`.
 * Byte-identical bodies short-circuit via `bodyHash` so re-runs stay idempotent.
 */
export async function archiveRawPayload(
  db: PrismaClient | Prisma.TransactionClient,
  payload: RawPayload,
  scopeKey: string,
): Promise<RawPayloadOutcome> {
  const bodyHash = createHash('sha256').update(JSON.stringify(payload.body)).digest('hex');
  const existing = await db.rawPayload.findUnique({
    where: { endpoint_scopeKey: { endpoint: payload.endpoint, scopeKey } },
    select: { id: true, bodyHash: true },
  });

  const data = {
    endpoint: payload.endpoint,
    scopeKey,
    url: payload.url,
    status: payload.status,
    fetchedAt: new Date(payload.fetchedAt),
    bytes: payload.bytes,
    attempts: payload.attempts,
    bodyHash,
    body: payload.body as Prisma.InputJsonValue,
  };

  if (!existing) {
    await db.rawPayload.create({ data });
    return 'created';
  }
  if (existing.bodyHash === bodyHash) return 'unchanged';
  await db.rawPayload.update({ where: { id: existing.id }, data });
  return 'updated';
}
