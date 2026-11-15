import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  MINOR_UNITS_PER_COIN,
  coinsToMinorUnits,
  minorUnitsToCoinsDecimal,
  formatMinorUnitsAsCoins,
  toPriceDecimal,
  toAuditDecimal,
  toMultiplierDecimal,
  toLiquidityDecimal,
  decimalCoinsToMinorUnits,
} from '@/lib/money';

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('R2.4 money & Decimal boundary helpers', () => {
  it('converts whole coins to bigint minor units and back without precision loss', () => {
    expect(MINOR_UNITS_PER_COIN).toBe(100n);
    expect(coinsToMinorUnits(10_000)).toBe(1_000_000n);
    expect(coinsToMinorUnits(10_000n)).toBe(1_000_000n);
    expect(coinsToMinorUnits('123.45')).toBe(12_345n);
    expect(coinsToMinorUnits(new Prisma.Decimal('99.99'))).toBe(9_999n);

    const back = minorUnitsToCoinsDecimal(12_345n);
    expect(back).toBeInstanceOf(Prisma.Decimal);
    expect(back.toFixed(2)).toBe('123.45');
    expect(formatMinorUnitsAsCoins(1_000_000n)).toBe('10000.00');
  });

  it('rounds Decimal coin amounts into minor units deterministically by direction', () => {
    const d = new Prisma.Decimal('10.123'); // 1012.3 minor units
    expect(decimalCoinsToMinorUnits(d, 'ceil')).toBe(1013n);
    expect(decimalCoinsToMinorUnits(d, 'floor')).toBe(1012n);
    expect(decimalCoinsToMinorUnits(d, 'half_up')).toBe(1012n);

    const d2 = new Prisma.Decimal('10.125'); // 1012.5 minor units
    expect(decimalCoinsToMinorUnits(d2, 'half_up')).toBe(1013n);
  });

  it('produces Prisma.Decimal instances at exact schema scales and rejects non-finite numbers', () => {
    expect(toPriceDecimal('123.456789').toFixed(4)).toBe('123.4568');
    expect(toAuditDecimal('0.123456789').toFixed(6)).toBe('0.123457');
    expect(toMultiplierDecimal('0.85678').toFixed(4)).toBe('0.8568');
    expect(toLiquidityDecimal('500.1234567').toFixed(6)).toBe('500.123457');

    expect(() => toPriceDecimal(Number.NaN)).toThrow(RangeError);
    expect(() => toPriceDecimal(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => toAuditDecimal(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
    expect(() => toMultiplierDecimal(Number.NaN)).toThrow(RangeError);
    expect(() => toLiquidityDecimal(Number.NaN)).toThrow(RangeError);
  });

  it('guards v2 engine directories against Number() float coercion at DB write boundaries', () => {
    const v2Dirs = ['src/lib/ingest', 'src/lib/derive', 'src/lib/valuation', 'src/lib/market'];
    const files = v2Dirs.flatMap(tsFilesUnder);
    expect(files.length).toBeGreaterThan(5);

    // Sync/DB-writer files in v2 must never coerce Decimal/BigInt columns with parseFloat or Number()
    // inside Prisma create/update payloads.
    const writerFiles = files.filter((f) => f.endsWith('sync.ts') || f.endsWith('writer.ts'));
    const offenders: string[] = [];
    const FORBIDDEN_COERCION = /\bparseFloat\s*\(/;
    for (const file of writerFiles) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (FORBIDDEN_COERCION.test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
