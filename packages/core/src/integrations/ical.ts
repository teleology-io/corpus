import { createHash } from 'node:crypto';
import { atLocal } from '../time';
import { normalizeRule, parseExdates, type SyncedFields } from './google';

// ---------------------------------------------------------------------------
// Google Calendar "secret address in iCal format" feeds (read-only, no OAuth)
// ---------------------------------------------------------------------------

/** Feeds are re-fetched at a random point in this window so they don't all fire together. */
export const ICAL_POLL_MIN_SEC = 5 * 60;
export const ICAL_POLL_MAX_SEC = 15 * 60;
export const icalPollInterval = (rand = Math.random) =>
	Math.round(ICAL_POLL_MIN_SEC + rand() * (ICAL_POLL_MAX_SEC - ICAL_POLL_MIN_SEC));

/** One subscribed feed; stored (encrypted) as JSON in the connection's access_token. */
export interface IcalFeed {
	/** Stable id derived from the URL — used as the mirrored calendar's external_id. */
	id: string;
	url: string;
}

export const feedId = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 24);

/**
 * Validates a Google iCal address (secret or public) and returns its canonical https URL.
 * Only calendar.google.com is accepted so the worker never fetches arbitrary hosts.
 * Throws Error with a user-facing message.
 */
export function parseIcalUrl(input: string): string {
	let u: URL;
	try {
		u = new URL(input.trim().replace(/^webcals?:\/\//i, 'https://'));
	} catch {
		throw new Error('That isn’t a valid URL');
	}
	if (u.protocol !== 'https:' || u.hostname !== 'calendar.google.com' || u.port)
		throw new Error('Use an iCal address from calendar.google.com');
	// Public share links (…/embed?src=ID, …?cid=BASE64) point at the calendar's public iCal feed.
	const shared = sharedCalendarId(u);
	if (shared)
		return `https://calendar.google.com/calendar/ical/${encodeURIComponent(shared)}/public/basic.ics`;
	if (!/^\/calendar\/ical\/[^/]+\/[^/]+\/[^/]+\.ics$/.test(u.pathname))
		throw new Error(
			'Expected a Google iCal address (…/calendar/ical/…/basic.ics) — Settings → Integrate calendar'
		);
	u.hash = '';
	return u.toString();
}

function sharedCalendarId(u: URL): string | null {
	if (u.pathname.startsWith('/calendar/ical/')) return null;
	const src = u.searchParams.get('src');
	if (src && /^[^\s/]+@[^\s/]+$/.test(src)) return src;
	const cid = u.searchParams.get('cid');
	if (!cid) return null;
	if (/^[^\s/]+@[^\s/]+$/.test(cid)) return cid;
	try {
		const decoded = Buffer.from(cid, 'base64').toString('utf8');
		return /^[^\s/]+@[^\s/]+$/.test(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

/** Calendar id embedded in a Google iCal URL (usually the owner's email). */
export function icalCalendarId(url: string): string | null {
	const m = new URL(url).pathname.match(/^\/calendar\/ical\/([^/]+)\//);
	return m ? decodeURIComponent(m[1]!) : null;
}

/** Fetch failures for one feed; 404 means the secret address was reset. */
export class IcalFetchError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

const MAX_BYTES = 20 * 1024 * 1024;

export async function fetchIcal(url: string, timeoutMs = 30_000): Promise<string> {
	const res = await fetch(url, {
		headers: { Accept: 'text/calendar' },
		// Google serves feeds directly; refusing redirects keeps fetches on calendar.google.com.
		redirect: 'error',
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (res.status === 404 || res.status === 403)
		throw new IcalFetchError(res.status, 'Feed not found — the address may have been reset or the calendar made private');
	if (!res.ok) throw new IcalFetchError(res.status, `Google returned ${res.status}`);
	const length = Number(res.headers.get('content-length') ?? 0);
	if (length > MAX_BYTES) throw new IcalFetchError(413, 'Feed is too large');
	const text = await res.text();
	if (text.length > MAX_BYTES) throw new IcalFetchError(413, 'Feed is too large');
	if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new IcalFetchError(422, 'Not an iCal feed');
	return text;
}

// ---------------------------------------------------------------------------
// Parsing (pure, unit tested)
// ---------------------------------------------------------------------------

interface Prop {
	name: string;
	params: Record<string, string>;
	value: string;
}

interface Component {
	type: string;
	props: Prop[];
	children: Component[];
	/** Raw lines, used to fingerprint the component. */
	raw: string[];
}

/** RFC 5545 §3.1: CRLF followed by a space or tab continues the previous line. */
function unfold(text: string): string[] {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/\n[ \t]/g, '')
		.split('\n');
}

function parseLine(line: string): Prop | null {
	// Split name;params from value at the first colon outside quotes.
	let quoted = false;
	let colon = -1;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') quoted = !quoted;
		else if (ch === ':' && !quoted) {
			colon = i;
			break;
		}
	}
	if (colon < 0) return null;
	const [name, ...rawParams] = line.slice(0, colon).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
	const params: Record<string, string> = {};
	for (const p of rawParams) {
		const eq = p.indexOf('=');
		if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
	}
	return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

function parseComponents(text: string): Component {
	const root: Component = { type: 'ROOT', props: [], children: [], raw: [] };
	const stack: Component[] = [root];
	for (const line of unfold(text)) {
		if (!line.trim()) continue;
		const p = parseLine(line);
		if (!p) continue;
		const top = stack[stack.length - 1]!;
		if (p.name === 'BEGIN') {
			const c: Component = { type: p.value.toUpperCase(), props: [], children: [], raw: [line] };
			top.children.push(c);
			stack.push(c);
			continue;
		}
		// DTSTAMP is the feed's generation time on Google — leave it out of fingerprints.
		if (p.name !== 'DTSTAMP') for (const c of stack) if (c !== root) c.raw.push(line);
		if (p.name === 'END') {
			if (stack.length > 1) stack.pop();
			continue;
		}
		top.props.push(p);
	}
	return root;
}

const unescapeText = (v: string) =>
	v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

const prop = (c: Component, name: string) => c.props.find((p) => p.name === name);
const text = (c: Component, name: string) => {
	const p = prop(c, name);
	return p ? unescapeText(p.value) : null;
};

const isoDate = (yyyymmdd: string) =>
	`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/** DATE / DATE-TIME (UTC, TZID or floating) → instant; `allDay` when VALUE=DATE. */
export function parseIcalTime(
	p: Prop,
	fallbackTz: string
): { at: Date; allDay: boolean; tz: string } {
	const v = p.value.trim();
	const tz = p.params.TZID ?? fallbackTz;
	if (/^\d{8}$/.test(v)) return { at: atLocal(isoDate(v), '00:00', tz), allDay: true, tz };
	const m = v.match(/^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/);
	if (!m) throw new Error(`Bad iCal time: ${v}`);
	const time = `${m[2]}:${m[3]}:${m[4]}`;
	if (m[5]) return { at: new Date(`${isoDate(m[1]!)}T${time}Z`), allDay: false, tz };
	return { at: atLocal(isoDate(m[1]!), time, tz), allDay: false, tz };
}

/** RFC 5545 duration (e.g. -PT15M, P1D, -P1DT2H) → signed minutes. */
export function parseDuration(v: string): number | null {
	const m = v
		.trim()
		.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
	if (!m) return null;
	const [, sign, w, d, h, min, s] = m;
	const total =
		Number(w ?? 0) * 10080 +
		Number(d ?? 0) * 1440 +
		Number(h ?? 0) * 60 +
		Number(min ?? 0) +
		Math.floor(Number(s ?? 0) / 60);
	return sign === '-' ? -total : total;
}

const RSVP: Record<string, string> = {
	'NEEDS-ACTION': 'pending',
	ACCEPTED: 'accepted',
	DECLINED: 'declined',
	TENTATIVE: 'tentative'
};

const mailto = (v: string) =>
	v
		.replace(/^mailto:/i, '')
		.trim()
		.toLowerCase();

export interface IcalEvent {
	uid: string;
	/** Set on an edited/cancelled instance of a recurring series. */
	recurrenceId: Date | null;
	cancelled: boolean;
	fields: SyncedFields;
	/** Fingerprint of the raw VEVENT — changes whenever Google changes the event. */
	hash: string;
}

export interface IcalCalendar {
	name: string | null;
	timezone: string | null;
	events: IcalEvent[];
}

/**
 * Parses a Google iCal feed. Google emits IANA TZIDs, so VTIMEZONE blocks are ignored.
 * Events that fail to parse are skipped rather than failing the whole feed.
 */
export function parseIcal(
	body: string,
	fallbackTz: string,
	selfEmail?: string | null
): IcalCalendar {
	const root = parseComponents(body);
	const cal = root.children.find((c) => c.type === 'VCALENDAR');
	if (!cal) throw new Error('Not an iCal feed (no VCALENDAR)');
	const calTz = text(cal, 'X-WR-TIMEZONE') ?? fallbackTz;
	const events: IcalEvent[] = [];
	for (const ve of cal.children.filter((c) => c.type === 'VEVENT')) {
		try {
			const e = parseEvent(ve, calTz, selfEmail?.toLowerCase() ?? null);
			if (e) events.push(e);
		} catch {
			// Malformed event: skip it.
		}
	}
	return { name: text(cal, 'X-WR-CALNAME'), timezone: text(cal, 'X-WR-TIMEZONE'), events };
}

function parseEvent(ve: Component, calTz: string, selfEmail: string | null): IcalEvent | null {
	const uid = text(ve, 'UID');
	const dtstart = prop(ve, 'DTSTART');
	if (!uid || !dtstart) return null;
	const start = parseIcalTime(dtstart, calTz);
	const dtend = prop(ve, 'DTEND');
	const duration = text(ve, 'DURATION');
	let endsAt: Date;
	if (dtend) endsAt = parseIcalTime(dtend, start.tz).at;
	else if (duration && parseDuration(duration) !== null)
		endsAt = new Date(start.at.getTime() + parseDuration(duration)! * 60_000);
	else endsAt = new Date(start.at.getTime() + (start.allDay ? 86_400_000 : 0));

	const rid = prop(ve, 'RECURRENCE-ID');
	const rrule = prop(ve, 'RRULE')?.value ?? null;
	const exdateLines = ve.props
		.filter((p) => p.name === 'EXDATE')
		.map(
			(p) =>
				`EXDATE${Object.entries(p.params)
					.map(([k, v]) => `;${k}=${v}`)
					.join('')}:${p.value}`
		);

	const reminders = ve.children
		.filter((c) => c.type === 'VALARM')
		.map((a) => prop(a, 'TRIGGER'))
		.filter((t): t is Prop => !!t && t.params.VALUE !== 'DATE-TIME')
		.map((t) => parseDuration(t.value))
		.filter((m): m is number => m !== null && m <= 0)
		.map((m) => -m);

	const organizer = prop(ve, 'ORGANIZER');
	const url = text(ve, 'URL');
	const meet = text(ve, 'X-GOOGLE-CONFERENCE');

	return {
		uid,
		recurrenceId: rid ? parseIcalTime(rid, start.tz).at : null,
		cancelled: text(ve, 'STATUS')?.toUpperCase() === 'CANCELLED',
		hash: createHash('sha256').update(ve.raw.join('\n')).digest('hex').slice(0, 32),
		fields: {
			title: text(ve, 'SUMMARY')?.trim() || '(No title)',
			description: text(ve, 'DESCRIPTION'),
			location: text(ve, 'LOCATION'),
			startsAt: start.at,
			endsAt,
			allDay: start.allDay,
			timezone: start.tz,
			rrule: rrule ? normalizeRule(rrule.replace(/^RRULE:/i, ''), start.allDay, start.tz) : null,
			exdates: parseExdates(exdateLines, start.tz),
			reminders: [...new Set(reminders)].slice(0, 5),
			attendees: ve.props
				.filter((p) => p.name === 'ATTENDEE' && /^mailto:/i.test(p.value))
				.filter((p) => p.params.CUTYPE !== 'RESOURCE' && p.params.CUTYPE !== 'ROOM')
				.map((p) => ({
					email: mailto(p.value),
					name: p.params.CN && p.params.CN.toLowerCase() !== mailto(p.value) ? p.params.CN : null,
					rsvp: RSVP[(p.params.PARTSTAT ?? 'NEEDS-ACTION').toUpperCase()] ?? 'pending'
				})),
			meta: {
				url: url ?? null,
				meetUrl: meet ?? null,
				organizer: organizer ? (organizer.params.CN ?? mailto(organizer.value)) || null : null,
				// The feed can't say who "you" are; the calendar owner (from the URL) is the best guess.
				organizerSelf: !organizer || !selfEmail || mailto(organizer.value) === selfEmail
			}
		}
	};
}
