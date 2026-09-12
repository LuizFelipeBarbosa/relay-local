import { describe, expect, it } from 'vitest';
import {
  formatBytes, formatCount, formatDuration, formatElapsed, formatMoney,
  formatPercent, formatRelative, formatTokens, shortDigest, splitModelId,
} from './format';

describe('formatTokens', () => {
  it('shows small counts exactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(63)).toBe('63');
    expect(formatTokens(9999)).toBe('9,999');
  });

  it('abbreviates larger counts', () => {
    expect(formatTokens(12_500)).toBe('12.5k');
    expect(formatTokens(250_000)).toBe('250k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });
});

describe('formatMoney', () => {
  it('keeps sub-cent estimates visible instead of rounding to zero', () => {
    // Real traffic at these prices earns fractions of a cent; $0.00 would read as "nothing earned".
    expect(formatMoney(0.0000171)).toBe('$0.0000171');
    expect(formatMoney(0.0000019)).toBe('$0.0000019');
    expect(formatMoney(0.0042)).toBe('$0.0042');
  });

  it('formats ordinary amounts', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(12.5)).toBe('$12.50');
  });
});

describe('formatDuration', () => {
  it('returns null when no duration was reported', () => {
    expect(formatDuration(undefined)).toBeNull();
  });

  it('scales the unit to the magnitude', () => {
    expect(formatDuration(156)).toBe('156 ms');
    expect(formatDuration(302)).toBe('302 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(45_000)).toBe('45.0 s');
    expect(formatDuration(125_000)).toBe('2m 05s');
  });
});

describe('formatElapsed', () => {
  it('summarizes long spans', () => {
    expect(formatElapsed(45)).toBe('45s');
    expect(formatElapsed(3600)).toBe('1h 0m');
    expect(formatElapsed(15_479)).toBe('4h 17m');
    expect(formatElapsed(200_000)).toBe('2d 7h');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-09-12T22:00:00Z');
  it('describes recency', () => {
    expect(formatRelative('2026-09-12T21:59:55Z', now)).toBe('just now');
    expect(formatRelative('2026-09-12T21:59:00Z', now)).toBe('1m ago');
    expect(formatRelative('2026-09-12T20:00:00Z', now)).toBe('2h ago');
    expect(formatRelative('2026-09-10T22:00:00Z', now)).toBe('2d ago');
  });

  it('handles an unparseable timestamp', () => {
    expect(formatRelative('nonsense', now)).toBe('—');
  });
});

describe('formatBytes and formatPercent', () => {
  it('formats memory sizes', () => {
    expect(formatBytes(17_179_869_184)).toBe('16.0 GB');
    expect(formatBytes(14_471_168_000)).toBe('13.5 GB');
    expect(formatBytes(0)).toBe('0 GB');
  });

  it('formats percentages', () => {
    expect(formatPercent(84.233)).toBe('84%');
    expect(formatPercent(18.385, 1)).toBe('18.4%');
  });
});

describe('identifiers', () => {
  it('truncates digests', () => {
    expect(shortDigest('388a0b599356d3508709fa595fc1af158e')).toBe('388a0b599356');
    expect(shortDigest('fake-digest-v1')).toBe('fake-digest-');
    expect(shortDigest(undefined)).toBeNull();
  });

  it('splits prefixed model ids', () => {
    expect(splitModelId('ollama/vaultbox/qwen3.5-uncensored:4b')).toEqual({ backend: 'ollama', name: 'vaultbox/qwen3.5-uncensored:4b' });
    expect(splitModelId('bare')).toEqual({ backend: '', name: 'bare' });
  });

  it('formats counts with separators', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
  });
});
