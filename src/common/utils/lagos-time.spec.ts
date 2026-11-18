import { lagosDateString, startOfLagosDay } from './lagos-time';

describe('lagos-time', () => {
  it('rolls over to the next day at midnight Lagos (23:00 UTC)', () => {
    expect(lagosDateString(new Date('2026-11-18T22:59:00Z'))).toBe(
      '2026-11-18',
    );
    expect(lagosDateString(new Date('2026-11-18T23:00:00Z'))).toBe(
      '2026-11-19',
    );
  });

  it('start of the Lagos day is 23:00 UTC the previous day', () => {
    expect(
      startOfLagosDay(new Date('2026-11-18T10:00:00Z')).toISOString(),
    ).toBe('2026-11-17T23:00:00.000Z');
  });
});
