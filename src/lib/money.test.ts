import { describe, expect, it } from 'vitest';
import { formatAmount, formatKES } from './money';

describe('formatKES', () => {
  it.each([
    [0, 'KES 0'],
    [80, 'KES 80'],
    [999, 'KES 999'],
    [1000, 'KES 1,000'],
    [1250, 'KES 1,250'],
    [86450, 'KES 86,450'],
    [1234567, 'KES 1,234,567'],
  ])('formats %d as %s', (amount, expected) => {
    expect(formatKES(amount)).toBe(expected);
  });

  it('never shows decimals', () => {
    expect(formatKES(300)).not.toMatch(/[.]/);
  });

  it('rejects floats: money is integer KES', () => {
    expect(() => formatKES(12.5)).toThrow(TypeError);
    expect(() => formatKES(Number.NaN)).toThrow(TypeError);
    expect(() => formatKES(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it('rejects negatives: shortfalls are written as words, not minus signs', () => {
    expect(() => formatKES(-300)).toThrow(RangeError);
  });
});

describe('formatAmount', () => {
  it('formats without the currency, for "KES 400 of 1,250 paid"', () => {
    expect(formatAmount(1250)).toBe('1,250');
  });
});
