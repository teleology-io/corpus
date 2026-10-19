import { TZDate } from '@date-fns/tz';

/**
 * Represent an instant's wall-clock time in `tz` as a "floating" Date whose UTC
 * fields equal the local fields. rrule expands floating dates without DST drift.
 */
export function toWallClock(instant: Date, tz: string): Date {
	const z = new TZDate(instant.getTime(), tz);
	return new Date(
		Date.UTC(
			z.getFullYear(),
			z.getMonth(),
			z.getDate(),
			z.getHours(),
			z.getMinutes(),
			z.getSeconds()
		)
	);
}

/** Inverse of toWallClock: interpret a floating date's UTC fields as local time in `tz`. */
export function fromWallClock(floating: Date, tz: string): Date {
	const z = new TZDate(
		floating.getUTCFullYear(),
		floating.getUTCMonth(),
		floating.getUTCDate(),
		floating.getUTCHours(),
		floating.getUTCMinutes(),
		floating.getUTCSeconds(),
		tz
	);
	return new Date(z.getTime());
}

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localDate(instant: Date, tz: string): string {
	const z = new TZDate(instant.getTime(), tz);
	return `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}`;
}

/** Instant for a local date + "HH:mm[:ss]" time in `tz`. */
export function atLocal(date: string, time: string, tz: string): Date {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	const [hh = 0, mm = 0, ss = 0] = time.split(':').map(Number);
	return new Date(new TZDate(y, m - 1, d, hh, mm, ss, tz).getTime());
}

/** Start of the local day in `tz`. */
export function startOfLocalDay(instant: Date, tz: string): Date {
	return atLocal(localDate(instant, tz), '00:00', tz);
}

export function addDaysToDate(date: string, days: number): string {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	const t = new Date(Date.UTC(y, m - 1, d + days));
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole calendar days from a to b (b - a). */
export function diffDates(a: string, b: string): number {
	const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
	const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
	return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function pad(n: number) {
	return String(n).padStart(2, '0');
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
