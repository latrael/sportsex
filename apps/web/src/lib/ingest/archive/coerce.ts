// Cell coercion for the archive CSVs.
//
// The one non-obvious thing: the archive was dumped from Python/pandas, so a
// missing value is written as the literal string "None", not an empty cell.
// Both mean null here.

const NULLISH = new Set(['', 'None', 'NA', 'nan']);

export function isNullish(v: string | undefined): boolean {
  return v === undefined || NULLISH.has(v.trim());
}

/** A required integer. Throws if the cell is missing — a malformed dump. */
export function int(v: string | undefined, field: string): number {
  if (isNullish(v))
    throw new Error(`archive: expected an integer for ${field}, got ${v ?? '<absent>'}`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`archive: ${field} is not a number: ${v}`);
  return Math.trunc(n);
}

export function intOrNull(v: string | undefined): number | null {
  if (isNullish(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function str(v: string | undefined): string {
  return isNullish(v) ? '' : (v as string);
}

export function strOrNull(v: string | undefined): string | null {
  return isNullish(v) ? null : (v as string);
}

/** A decimal kept as the wire string, exactly as R1.1 keeps them. Null → "0". */
export function decimalStr(v: string | undefined): string {
  return isNullish(v) ? '0' : (v as string).trim();
}

/** Python's `True`/`False`. */
export function bool(v: string | undefined): boolean {
  return (v ?? '').trim().toLowerCase() === 'true';
}
