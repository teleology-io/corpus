import * as rrulePkg from 'rrule';
import { DAY, fromWallClock, toWallClock } from './time';

// rrule ships UMD for Node and ESM for bundlers: named export under Vite, default under Node ESM.
const RRule = (rrulePkg.RRule ??
	(rrulePkg as unknown as { default: typeof rrulePkg }).default.RRule) as typeof rrulePkg.RRule;

export interface RecurringSource {
	id: string;
	startsAt: Date;
	endsAt: Date;
	timezone: string;
	allDay?: boolean;
	rrule: string | null;
	exdates?: Date[];
}

export interface OccurrencePatch {
	title?: string;
	description?: string | null;
	location?: string | null;
	color?: string;
	startsAt?: string;
	endsAt?: string;
	cancelled?: boolean;
}

export interface Override {
	originalStart: Date;
	patch: OccurrencePatch;
}

export interface Occurrence<T extends RecurringSource = RecurringSource> {
	source: T;
	/** Unmodified start from the rule — identifies the occurrence for overrides */
	originalStart: Date;
	start: Date;
	end: Date;
	recurring: boolean;
	patch?: OccurrencePatch;
}

function buildRule(source: RecurringSource) {
	const options = RRule.parseString(source.rrule!.replace(/^RRULE:/i, ''));
	// UNTIL is a real UTC instant (RFC 5545, same as Google); compare in floating time.
	if (options.until) options.until = toWallClock(options.until, source.timezone);
	return new RRule({ ...options, dtstart: toWallClock(source.startsAt, source.timezone) });
}

/** Raw rule start times (no overrides/exdates) between [from, to). */
export function ruleStarts(source: RecurringSource, from: Date, to: Date): Date[] {
	if (!source.rrule) return [source.startsAt];
	const rule = buildRule(source);
	// Pad by a day each side because floating times are offset from real instants.
	const floating = rule.between(
		toWallClock(new Date(from.getTime() - DAY), source.timezone),
		toWallClock(new Date(to.getTime() + DAY), source.timezone),
		true
	);
	return floating.map((f) => fromWallClock(f, source.timezone));
}

/**
 * Expand an event (recurring or not) into concrete occurrences overlapping [from, to).
 * Applies EXDATEs and per-occurrence overrides (moved/cancelled/edited).
 */
export function expand<T extends RecurringSource>(
	source: T,
	from: Date,
	to: Date,
	overrides: Override[] = []
): Occurrence<T>[] {
	const duration = source.endsAt.getTime() - source.startsAt.getTime();
	const recurring = !!source.rrule;
	const excluded = new Set((source.exdates ?? []).map((d) => d.getTime()));
	const byStart = new Map(overrides.map((o) => [o.originalStart.getTime(), o.patch]));

	const starts = recurring
		? ruleStarts(source, new Date(from.getTime() - duration), to)
		: [source.startsAt];

	const out: Occurrence<T>[] = [];
	for (const originalStart of starts) {
		const key = originalStart.getTime();
		if (excluded.has(key)) continue;
		const patch = byStart.get(key);
		if (patch?.cancelled) continue;
		const start = patch?.startsAt ? new Date(patch.startsAt) : originalStart;
		const end = patch?.endsAt ? new Date(patch.endsAt) : new Date(start.getTime() + duration);
		if (end.getTime() <= from.getTime() || start.getTime() >= to.getTime()) {
			// zero-length events (reminders) still count when start is inside the window
			if (!(duration === 0 && start >= from && start < to)) continue;
		}
		out.push({ source, originalStart, start, end, recurring, patch });
	}
	return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Next occurrence start strictly after `after`, or null. */
export function nextStart(source: RecurringSource, after: Date): Date | null {
	if (!source.rrule) return source.startsAt > after ? source.startsAt : null;
	const rule = buildRule(source);
	const excluded = new Set((source.exdates ?? []).map((d) => d.getTime()));
	let cursor = toWallClock(after, source.timezone);
	for (let i = 0; i < 50; i++) {
		const next = rule.after(cursor, false);
		if (!next) return null;
		const real = fromWallClock(next, source.timezone);
		if (real > after && !excluded.has(real.getTime())) return real;
		cursor = next;
	}
	return null;
}

/** Truncate a rule so it ends right before `before` (for "this and following" edits). */
export function truncateRule(rrule: string, before: Date): string {
	const options = RRule.parseString(rrule.replace(/^RRULE:/i, ''));
	delete options.count;
	options.until = new Date(before.getTime() - 1000);
	return RRule.optionsToString(options).replace(/^RRULE:/, '');
}

export type Frequency =
	'none' | 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';

/** Build an RRULE body for the simple repeat presets the UI offers. */
export function presetRule(
	freq: Frequency,
	start: Date,
	tz: string,
	until?: Date | null
): string | null {
	if (freq === 'none') return null;
	const day = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][toWallClock(start, tz).getUTCDay()];
	const base: Record<Exclude<Frequency, 'none'>, string> = {
		daily: 'FREQ=DAILY',
		weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
		weekly: `FREQ=WEEKLY;BYDAY=${day}`,
		biweekly: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${day}`,
		monthly: 'FREQ=MONTHLY',
		yearly: 'FREQ=YEARLY'
	};
	let rule = base[freq];
	if (until) {
		const u = until
			.toISOString()
			.replace(/[-:]/g, '')
			.replace(/\.\d{3}/, '');
		rule += `;UNTIL=${u}`;
	}
	return rule;
}

/** Map an RRULE back to a preset, or 'custom'. */
export function rulePreset(rrule: string | null): Frequency | 'custom' {
	if (!rrule) return 'none';
	const r = rrule.replace(/;UNTIL=[^;]+/, '').replace(/;COUNT=\d+/, '');
	if (r === 'FREQ=DAILY') return 'daily';
	if (r === 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR') return 'weekdays';
	if (/^FREQ=WEEKLY;BYDAY=[A-Z]{2}$/.test(r)) return 'weekly';
	if (/^FREQ=WEEKLY;INTERVAL=2;BYDAY=[A-Z]{2}$/.test(r)) return 'biweekly';
	if (r === 'FREQ=MONTHLY') return 'monthly';
	if (r === 'FREQ=YEARLY') return 'yearly';
	return 'custom';
}

export function describeRule(rrule: string | null): string {
	if (!rrule) return 'Does not repeat';
	try {
		return RRule.fromString(rrule.replace(/^RRULE:/i, '')).toText();
	} catch {
		return 'Custom';
	}
}

/** UNTIL of a rule as a real instant, or null. */
export function ruleUntil(rrule: string | null): Date | null {
	const m = rrule?.match(/UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/);
	if (!m) return null;
	const [, y, mo, d, h = '23', mi = '59', se = '59'] = m;
	return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +se));
}
