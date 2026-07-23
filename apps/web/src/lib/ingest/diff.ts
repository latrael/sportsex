// Shared write path for every ingestion job.
//
// The rule the whole of Phase 1 is built around: **a row is written only when
// its content actually changed**. Prisma's `upsert` always issues an UPDATE, so
// a re-run of the 25/26 backfill would touch 25k rows and report 25k writes
// even though nothing moved. Diffing first is what makes R1.7's "a second run
// reports zero row changes" true rather than merely approximately true.
//
// Rows that exist in the database but not in the payload are left alone. FPL
// drops elements mid-season (a player leaves the league); the history we hold
// for them stays valid, so ingestion never deletes.

import { Prisma } from '@prisma/client';

export type SyncCounts = {
  created: number;
  updated: number;
  unchanged: number;
};

/**
 * Compare one planned field against what the database returned.
 *
 * Prisma hands back `Date` for date columns and `Decimal` for numeric ones, so
 * `===` would report every row as changed on every run.
 */
export function sameFieldValue(planned: unknown, stored: unknown): boolean {
  if (planned === null || planned === undefined) return stored === null || stored === undefined;
  if (stored === null || stored === undefined) return false;

  if (planned instanceof Date || stored instanceof Date) {
    return (
      planned instanceof Date && stored instanceof Date && planned.getTime() === stored.getTime()
    );
  }

  if (Prisma.Decimal.isDecimal(planned) || Prisma.Decimal.isDecimal(stored)) {
    return new Prisma.Decimal(planned as Prisma.Decimal.Value).equals(
      new Prisma.Decimal(stored as Prisma.Decimal.Value),
    );
  }

  return planned === stored;
}

function rowMatches(data: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.keys(data).every((field) => sameFieldValue(data[field], row[field]));
}

/**
 * Create the rows that are missing, update only the rows whose content moved,
 * and count the rest as untouched.
 */
export async function applyDiff<P, R extends { id: number }, D extends Record<string, unknown>>(opts: {
  planned: readonly P[];
  existing: readonly R[];
  keyOfPlanned: (planned: P) => string;
  keyOfExisting: (row: R) => string;
  dataOf: (planned: P) => D;
  createMany: (rows: D[]) => Promise<unknown>;
  update: (id: number, data: D) => Promise<unknown>;
}): Promise<SyncCounts> {
  const byKey = new Map(opts.existing.map((row) => [opts.keyOfExisting(row), row]));

  const toCreate: D[] = [];
  const toUpdate: Array<{ id: number; data: D }> = [];
  let unchanged = 0;

  for (const planned of opts.planned) {
    const data = opts.dataOf(planned);
    const row = byKey.get(opts.keyOfPlanned(planned));

    if (!row) {
      toCreate.push(data);
    } else if (rowMatches(data, row as unknown as Record<string, unknown>)) {
      unchanged += 1;
    } else {
      toUpdate.push({ id: row.id, data });
    }
  }

  if (toCreate.length > 0) await opts.createMany(toCreate);
  for (const { id, data } of toUpdate) await opts.update(id, data);

  return { created: toCreate.length, updated: toUpdate.length, unchanged };
}
