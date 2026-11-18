/**
 * Shops run on Lagos time, servers usually run on UTC. Every user-facing date
 * (receipts, "today", daily summaries) must use this zone, or a sale at
 * 11:30pm shows up on the wrong day.
 *
 * Nigeria is UTC+1 all year (no daylight saving), so a fixed offset is safe.
 */
export const LAGOS_TIME_ZONE = 'Africa/Lagos';
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** YYYY-MM-DD for the given instant, as seen in Lagos. */
export function lagosDateString(date: Date = new Date()): string {
  return new Date(date.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYYMMDD for the given instant, as seen in Lagos. */
export function lagosDateCompact(date: Date = new Date()): string {
  return lagosDateString(date).replace(/-/g, '');
}

/** The UTC instant at which the Lagos day containing `date` started. */
export function startOfLagosDay(date: Date = new Date()): Date {
  const lagos = new Date(date.getTime() + LAGOS_OFFSET_MS);
  lagos.setUTCHours(0, 0, 0, 0);
  return new Date(lagos.getTime() - LAGOS_OFFSET_MS);
}
