import { describe, it, expect } from 'vitest';
import { canonName } from '@/lib/canon';

describe('canonName', () => {
  it('lowercases', () => {
    expect(canonName('Mohamed Salah')).toBe('mohamed salah');
  });

  it('strips accents/diacritics', () => {
    expect(canonName('Erling Haaland')).toBe('erling haaland');
    expect(canonName('Bernardo Silva')).toBe('bernardo silva');
    expect(canonName('Raphaël Varane')).toBe('raphael varane');
  });

  it('removes punctuation', () => {
    expect(canonName("Son Heung-min")).toBe('son heungmin');
    expect(canonName("O'Brien")).toBe('obrien');
  });

  it('collapses multiple spaces', () => {
    expect(canonName('A   B')).toBe('a b');
  });

  it('trims leading and trailing whitespace', () => {
    expect(canonName('  Kevin De Bruyne  ')).toBe('kevin de bruyne');
  });

  it('handles an empty string', () => {
    expect(canonName('')).toBe('');
  });

  it('strips non-ascii symbols', () => {
    expect(canonName('Vinícius Júnior')).toBe('vinicius junior');
  });

  it('preserves numbers', () => {
    expect(canonName('Player 1')).toBe('player 1');
  });
});
