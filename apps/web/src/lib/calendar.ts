import { TZDate } from '@date-fns/tz';
import { addDaysToDate, atLocal, diffDates, localDate } from '@corpus/core';

export type View = 'week' | 'month' | 'year';

export const HOUR_PX = 64;
export const SNAP_MIN = 15;

export const DAY_NAMES = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday'
];
export const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

export function parseDate(date: string) {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	return { y, m, d };
}

/** Day of week (0=Sun) for a YYYY-MM-DD date. */
export function weekday(date: string) {
	const { y, m, d } = parseDate(date);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function startOfWeek(date: string, weekStartsOn = 0) {
	return addDaysToDate(date, -((weekday(date) - weekStartsOn + 7) % 7));
}

export function startOfMonth(date: string) {
	const { y, m } = parseDate(date);
	return `${y}-${String(m).padStart(2, '0')}-01`;
}

export function addMonths(date: string, n: number) {
	const { y, m, d } = parseDate(date);
	const t = new Date(Date.UTC(y, m - 1 + n, 1));
	const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
	return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Visible date span for a view: [start, end) as YYYY-MM-DD. */
export function viewRange(view: View, date: string, weekStartsOn = 0) {
	if (view === 'week') {
		const start = startOfWeek(date, weekStartsOn);
		return { start, end: addDaysToDate(start, 7) };
	}
	if (view === 'month') {
		const start = startOfWeek(startOfMonth(date), weekStartsOn);
		return { start, end: addDaysToDate(start, 42) };
	}
	const { y } = parseDate(date);
	return { start: `${y}-01-01`, end: `${y + 1}-01-01` };
}

export function shiftDate(view: View, date: string, dir: 1 | -1) {
	if (view === 'week') return addDaysToDate(date, 7 * dir);
	if (view === 'month') return addMonths(date, dir);
	return addMonths(date, 12 * dir);
}

export function datesBetween(start: string, end: string) {
	const out: string[] = [];
	for (let d = start; diffDates(d, end) > 0; d = addDaysToDate(d, 1)) out.push(d);
	return out;
}

export function tzParts(iso: string | Date, tz: string) {
	const z = new TZDate(new Date(iso).getTime(), tz);
	return { date: localDate(new Date(iso), tz), hours: z.getHours(), minutes: z.getMinutes() };
}

/** Minutes since local midnight of `date` (can exceed 1440 or be negative). */
export function minutesInto(date: string, iso: string, tz: string) {
	return (new Date(iso).getTime() - atLocal(date, '00:00', tz).getTime()) / 60_000;
}

export function formatTime(iso: string | Date, tz: string, opts: { compact?: boolean } = {}) {
	const s = new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: tz
	}).format(new Date(iso));
	return opts.compact ? s.replace(':00', '').replace(' ', '').toLowerCase() : s;
}

export function formatDay(
	date: string,
	opts: Intl.DateTimeFormatOptions = {
		weekday: 'short',
		month: 'long',
		day: 'numeric',
		year: 'numeric'
	}
) {
	const { y, m, d } = parseDate(date);
	return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(
		new Date(Date.UTC(y, m - 1, d))
	);
}

export function gmtLabel(tz: string) {
	const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
		.formatToParts(new Date())
		.find((p) => p.type === 'timeZoneName');
	return part?.value ?? 'GMT';
}

export function toLocalInput(iso: string | Date, tz: string) {
	const p = tzParts(iso, tz);
	return {
		date: p.date,
		time: `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`
	};
}

export function fromLocalInput(date: string, time: string, tz: string) {
	return atLocal(date, time, tz).toISOString();
}

/** Hex color with alpha (for tinted card backgrounds). */
export function tint(hex: string, alpha: number) {
	const n = parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}

export interface Placed<T> {
	item: T;
	top: number;
	height: number;
	col: number;
	cols: number;
}

/**
 * Lay out overlapping timed items in a day column: greedy column assignment
 * within each cluster of transitively-overlapping items.
 */
export function layoutDay<T>(items: { item: T; startMin: number; endMin: number }[]): Placed<T>[] {
	const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
	const out: Placed<T>[] = [];
	let cluster: { entry: (typeof sorted)[number]; col: number }[] = [];
	let clusterEnd = -Infinity;
	const flush = () => {
		const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
		for (const c of cluster) {
			const top = Math.max(0, c.entry.startMin);
			const end = Math.min(24 * 60, Math.max(c.entry.endMin, c.entry.startMin + 20));
			out.push({
				item: c.entry.item,
				top: (top / 60) * HOUR_PX,
				height: ((end - top) / 60) * HOUR_PX,
				col: c.col,
				cols
			});
		}
		cluster = [];
	};
	for (const entry of sorted) {
		const visualEnd = Math.max(entry.endMin, entry.startMin + 20);
		if (entry.startMin >= clusterEnd) {
			flush();
			clusterEnd = -Infinity;
		}
		const colEnds: number[] = [];
		for (const c of cluster)
			colEnds[c.col] = Math.max(
				colEnds[c.col] ?? -Infinity,
				Math.max(c.entry.endMin, c.entry.startMin + 20)
			);
		let col = colEnds.findIndex((end) => end <= entry.startMin);
		if (col === -1) col = colEnds.length;
		cluster.push({ entry, col });
		clusterEnd = Math.max(clusterEnd, visualEnd);
	}
	flush();
	return out;
}

export function snap(min: number) {
	return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

export { addDaysToDate, diffDates, localDate, atLocal };
