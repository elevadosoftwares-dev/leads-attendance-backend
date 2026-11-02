import { describe, expect, it } from 'vitest';
import { initialsOf, percent } from '../../src/utils/format';
import { haversineMeters } from '../../src/utils/geo';
import {
  addDaysToWorkDate,
  combineWorkDateAndTime,
  computeIsLate,
  isoUtc,
  monthRange,
  nextWorkDate,
  toLocalTime,
  toWorkDate,
} from '../../src/utils/time';

describe('haversineMeters', () => {
  it('is zero for the same point', () => {
    expect(haversineMeters(1.417, 103.868, 1.417, 103.868)).toBe(0);
  });

  it('matches known distances', () => {
    // 0.001° of latitude ≈ 111.2 m everywhere.
    expect(haversineMeters(1.417, 103.868, 1.418, 103.868)).toBeCloseTo(111.2, 0);
    // Singapore Changi (1.3644, 103.9915) to Seletar (1.4170, 103.8680): ≈ 14.9 km.
    expect(haversineMeters(1.3644, 103.9915, 1.417, 103.868) / 1000).toBeCloseTo(14.9, 0);
  });

  it('is symmetric', () => {
    const a = haversineMeters(1.3, 103.8, 1.45, 103.9);
    const b = haversineMeters(1.45, 103.9, 1.3, 103.8);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('time helpers (Asia/Singapore)', () => {
  it('computes the SG work date, not the UTC date', () => {
    // 2026-10-15 16:30 UTC is 2026-10-16 00:30 in Singapore.
    expect(toWorkDate(new Date('2026-10-15T16:30:00Z'))).toBe('2026-10-16');
    expect(toWorkDate(new Date('2026-10-15T15:59:59Z'))).toBe('2026-10-15');
  });

  it('combines a work date and local time into UTC', () => {
    expect(combineWorkDateAndTime('2026-10-16', '09:00').toISOString()).toBe('2026-10-16T01:00:00.000Z');
    expect(combineWorkDateAndTime('2026-10-16', '00:30').toISOString()).toBe('2026-10-15T16:30:00.000Z');
  });

  it('formats local time of day', () => {
    expect(toLocalTime(new Date('2026-10-16T07:15:00Z'))).toBe('15:15');
  });

  it('rejects malformed inputs', () => {
    expect(() => combineWorkDateAndTime('16/10/2026', '09:00')).toThrow();
    expect(() => combineWorkDateAndTime('2026-10-16', '9am')).toThrow();
  });

  it('adds days and skips weekends for the next work date', () => {
    expect(addDaysToWorkDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(nextWorkDate('2026-10-15')).toBe('2026-10-16'); // Thu → Fri
    expect(nextWorkDate('2026-10-16')).toBe('2026-10-19'); // Fri → Mon
    expect(nextWorkDate('2026-10-17')).toBe('2026-10-19'); // Sat → Mon
  });

  it('computes month ranges', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('serializes ISO UTC without milliseconds', () => {
    expect(isoUtc(new Date('2026-10-16T00:54:00.123Z'))).toBe('2026-10-16T00:54:00Z');
    expect(isoUtc(null)).toBeNull();
  });
});

describe('computeIsLate (shift 09:00, 10 minutes grace)', () => {
  const at = (hhmmss: string) => new Date(`2026-10-16T${hhmmss}+08:00`);

  it('is on time up to and including the grace boundary', () => {
    expect(computeIsLate(at('08:45:00'), '2026-10-16', '09:00', 10)).toBe(false);
    expect(computeIsLate(at('09:09:59'), '2026-10-16', '09:00', 10)).toBe(false);
    expect(computeIsLate(at('09:10:00'), '2026-10-16', '09:00', 10)).toBe(false);
  });

  it('is late strictly after the grace boundary', () => {
    expect(computeIsLate(at('09:10:01'), '2026-10-16', '09:00', 10)).toBe(true);
    expect(computeIsLate(at('11:00:00'), '2026-10-16', '09:00', 10)).toBe(true);
  });

  it('respects per-user shift start', () => {
    expect(computeIsLate(at('09:30:00'), '2026-10-16', '09:30', 10)).toBe(false);
    expect(computeIsLate(at('09:41:00'), '2026-10-16', '09:30', 10)).toBe(true);
  });
});

describe('format helpers', () => {
  it('builds initials', () => {
    expect(initialsOf('Mark Tan')).toBe('MT');
    expect(initialsOf('Siti Nur Aminah')).toBe('SA');
    expect(initialsOf('Admin')).toBe('AD');
  });

  it('computes rounded percentages', () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(2, 3)).toBe(67);
    expect(percent(0, 0)).toBe(0);
  });
});
