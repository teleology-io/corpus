import { atLocal, localDate, toWallClock } from '../time';
import { ruleUntil } from '../recurrence';
import type { Provider, TokenSet } from './types';
import { ProviderAuthError } from './types';

const API = 'https://www.googleapis.com/calendar/v3';
/** Full calendar access: list calendars + read/write events. */
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export interface GCalendar {
	id: string;
	summary: string;
	summaryOverride?: string;
	backgroundColor?: string;
	timeZone?: string;
	accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
	primary?: boolean;
	defaultReminders?: { method: string; minutes: number }[];
}

export interface GTime {
	dateTime?: string;
	date?: string;
	timeZone?: string;
}

export interface GAttendee {
	email?: string;
	displayName?: string;
	self?: boolean;
	resource?: boolean;
	responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
}

export interface GEvent {
	id: string;
	status?: 'confirmed' | 'tentative' | 'cancelled';
	etag?: string;
	summary?: string;
	description?: string;
	location?: string;
	htmlLink?: string;
	hangoutLink?: string;
	start?: GTime;
	end?: GTime;
	recurrence?: string[];
	recurringEventId?: string;
	originalStartTime?: GTime;
	organizer?: { email?: string; displayName?: string; self?: boolean };
	attendees?: GAttendee[];
	reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] };
	updated?: string;
}

export class GoogleApiError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

async function call<T>(
	token: string,
	path: string,
	init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}
): Promise<T> {
	const url = new URL(API + path);
	for (const [k, v] of Object.entries(init.query ?? {}))
		if (v !== undefined) url.searchParams.set(k, v);
	const res = await fetch(url, {
		method: init.method ?? 'GET',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: init.body === undefined ? undefined : JSON.stringify(init.body)
	});
	if (res.status === 401) throw new ProviderAuthError('Google token rejected');
	if (res.status === 204) return undefined as T;
	const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
	if (!res.ok) throw new GoogleApiError(res.status, json.error?.message ?? `Google ${res.status}`);
	return json as T;
}

const enc = encodeURIComponent;

/** Thin Google Calendar v3 client. */
export const gcal = {
	async calendars(token: string): Promise<GCalendar[]> {
		const out: GCalendar[] = [];
		let pageToken: string | undefined;
		do {
			const page = await call<{ items?: GCalendar[]; nextPageToken?: string }>(
				token,
				'/users/me/calendarList',
				{ query: { maxResults: '250', pageToken } }
			);
			out.push(...(page.items ?? []));
			pageToken = page.nextPageToken;
		} while (pageToken);
		return out;
	},

	/**
	 * Full sync (timeMin) or incremental sync (syncToken). Recurring series come back as
	 * masters plus exception instances. Throws GoogleApiError(410) when the token expired.
	 */
	async events(
		token: string,
		calendarId: string,
		opts: { syncToken?: string | null; timeMin?: Date }
	): Promise<{ events: GEvent[]; nextSyncToken: string | null }> {
		const events: GEvent[] = [];
		let pageToken: string | undefined;
		let nextSyncToken: string | null = null;
		do {
			const page = await call<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
				token,
				`/calendars/${enc(calendarId)}/events`,
				{
					query: {
						maxResults: '250',
						pageToken,
						syncToken: opts.syncToken ?? undefined,
						timeMin: opts.syncToken ? undefined : opts.timeMin?.toISOString()
					}
				}
			);
			events.push(...(page.items ?? []));
			pageToken = page.nextPageToken;
			nextSyncToken = page.nextSyncToken ?? nextSyncToken;
		} while (pageToken);
		return { events, nextSyncToken };
	},

	insert(token: string, calendarId: string, body: Partial<GEvent>) {
		return call<GEvent>(token, `/calendars/${enc(calendarId)}/events`, {
			method: 'POST',
			body,
			query: { sendUpdates: 'none' }
		});
	},

	patch(token: string, calendarId: string, eventId: string, body: Partial<GEvent>) {
		return call<GEvent>(token, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, {
			method: 'PATCH',
			body,
			query: { sendUpdates: 'none' }
		});
	},

	async remove(token: string, calendarId: string, eventId: string) {
		try {
			await call(token, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, {
				method: 'DELETE',
				query: { sendUpdates: 'none' }
			});
		} catch (e) {
			// Already gone on Google's side — that's the goal anyway.
			if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) throw e;
		}
	}
};

// ---------------------------------------------------------------------------
// Mapping between Google events and Corpus events (pure, unit tested)
// ---------------------------------------------------------------------------

export interface SyncedFields {
	title: string;
	description: string | null;
	location: string | null;
	startsAt: Date;
	endsAt: Date;
	allDay: boolean;
	timezone: string;
	rrule: string | null;
	exdates: Date[];
	reminders: number[];
	attendees: { email: string; name: string | null; rsvp: string }[];
	meta: ExternalMeta;
}

export interface ExternalMeta {
	url?: string | null;
	meetUrl?: string | null;
	organizer?: string | null;
	organizerSelf?: boolean;
}

const RSVP: Record<string, string> = {
	needsAction: 'pending',
	accepted: 'accepted',
	declined: 'declined',
	tentative: 'tentative'
};

const compact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const compactDate = (date: string) => date.replace(/-/g, '');
const isoDate = (yyyymmdd: string) =>
	`${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/** Instant of a Google start/originalStartTime (all-day dates are midnight in `tz`). */
export function googleInstant(t: GTime, tz: string): Date {
	return t.dateTime ? new Date(t.dateTime) : atLocal(t.date!, '00:00', tz);
}

/** Parse `EXDATE[;TZID=..|;VALUE=DATE]:a,b` lines into instants. */
export function parseExdates(lines: string[], tz: string): Date[] {
	const out: Date[] = [];
	for (const line of lines) {
		const m = line.match(/^EXDATE([^:]*):(.+)$/i);
		if (!m) continue;
		const zone = m[1]!.match(/TZID=([^;]+)/i)?.[1] ?? tz;
		for (const v of m[2]!.split(',')) {
			const t = v.trim();
			if (/^\d{8}$/.test(t)) out.push(atLocal(isoDate(t), '00:00', zone));
			else if (/^\d{8}T\d{6}Z$/.test(t))
				out.push(
					new Date(`${isoDate(t)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`)
				);
			else if (/^\d{8}T\d{6}$/.test(t))
				out.push(
					atLocal(isoDate(t), `${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}`, zone)
				);
		}
	}
	return out;
}

/** Corpus keeps UNTIL as a UTC instant; Google all-day rules use an inclusive date. */
function normalizeRule(rule: string, allDay: boolean, tz: string): string {
	const m = rule.match(/UNTIL=(\d{8})(?=;|$)/);
	if (!m || !allDay) return rule;
	const until = atLocal(isoDate(m[1]!), '23:59:59', tz);
	return rule.replace(m[0], `UNTIL=${compact(until.toISOString())}`);
}

/** Map a (non-cancelled, non-instance) Google event to Corpus fields. */
export function fromGoogle(
	e: GEvent,
	calendarTz: string,
	defaultReminders: number[]
): SyncedFields {
	const allDay = !!e.start?.date;
	const timezone = e.start?.timeZone ?? calendarTz;
	const startsAt = googleInstant(e.start!, timezone);
	const endsAt = e.end ? googleInstant(e.end, timezone) : startsAt;
	const rruleLine = e.recurrence?.find((l) => /^RRULE:/i.test(l));
	return {
		title: e.summary?.trim() || '(No title)',
		description: e.description ?? null,
		location: e.location ?? null,
		startsAt,
		endsAt,
		allDay,
		timezone,
		rrule: rruleLine ? normalizeRule(rruleLine.replace(/^RRULE:/i, ''), allDay, timezone) : null,
		exdates: parseExdates(e.recurrence ?? [], timezone),
		reminders:
			e.reminders && !e.reminders.useDefault
				? (e.reminders.overrides ?? []).map((r) => r.minutes).slice(0, 5)
				: defaultReminders.slice(0, 5),
		attendees: (e.attendees ?? [])
			.filter((a): a is GAttendee & { email: string } => !!a.email && !a.resource)
			.map((a) => ({
				email: a.email.toLowerCase(),
				name: a.displayName ?? null,
				rsvp: RSVP[a.responseStatus ?? 'needsAction'] ?? 'pending'
			})),
		meta: {
			url: e.htmlLink ?? null,
			meetUrl: e.hangoutLink ?? null,
			organizer: e.organizer?.displayName ?? e.organizer?.email ?? null,
			organizerSelf: e.organizer?.self ?? true
		}
	};
}

export interface PushableEvent {
	title: string;
	description: string | null;
	location: string | null;
	startsAt: Date;
	endsAt: Date;
	allDay: boolean;
	timezone: string;
	rrule: string | null;
	exdates: Date[];
	reminders: number[];
	attendees: { email: string; name?: string | null }[];
}

function googleTime(at: Date, allDay: boolean, tz: string): GTime {
	return allDay ? { date: localDate(at, tz) } : { dateTime: at.toISOString(), timeZone: tz };
}

/** Corpus event → Google request body. */
export function toGoogle(e: PushableEvent): Partial<GEvent> {
	const recurrence: string[] = [];
	if (e.rrule) {
		let rule = e.rrule;
		const until = ruleUntil(rule);
		// All-day series need a DATE-valued UNTIL to match their DATE start.
		if (until && e.allDay)
			rule = rule.replace(/UNTIL=[^;]+/, `UNTIL=${compactDate(localDate(until, e.timezone))}`);
		recurrence.push(`RRULE:${rule}`);
		if (e.exdates.length) {
			recurrence.push(
				e.allDay
					? `EXDATE;VALUE=DATE:${e.exdates.map((d) => compactDate(localDate(d, e.timezone))).join(',')}`
					: `EXDATE;TZID=${e.timezone}:${e.exdates
							.map((d) => compact(toWallClock(d, e.timezone).toISOString()).replace(/Z$/, ''))
							.join(',')}`
			);
		}
	}
	return {
		summary: e.title,
		description: e.description ?? '',
		location: e.location ?? '',
		start: googleTime(e.startsAt, e.allDay, e.timezone),
		end: googleTime(e.endsAt, e.allDay, e.timezone),
		recurrence,
		reminders: {
			useDefault: false,
			overrides: e.reminders.slice(0, 5).map((minutes) => ({ method: 'popup', minutes }))
		},
		attendees: e.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined }))
	};
}

/** Google's id for one instance of a recurring series. */
export function instanceId(masterId: string, originalStart: Date, allDay: boolean, tz: string) {
	return allDay
		? `${masterId}_${compactDate(localDate(originalStart, tz))}`
		: `${masterId}_${compact(originalStart.toISOString())}`;
}

// ---------------------------------------------------------------------------
// OAuth provider
// ---------------------------------------------------------------------------

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params)
	});
	const body = (await res.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		error_description?: string;
		error?: string;
	};
	if (!body.access_token)
		throw new ProviderAuthError(body.error_description ?? body.error ?? 'Google OAuth failed');
	return {
		accessToken: body.access_token,
		refreshToken: body.refresh_token ?? null,
		expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null,
		scopes: body.scope ?? null
	};
}

export const googleCalendar: Provider = {
	id: 'google-calendar',
	name: 'Google Calendar',
	appSetupUrl: 'https://console.cloud.google.com/apis/credentials/oauthclient',
	envPrefix: 'GOOGLE',
	authorizeUrl(cfg, state) {
		const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
		u.searchParams.set('client_id', cfg.clientId);
		u.searchParams.set('redirect_uri', cfg.redirectUri);
		u.searchParams.set('response_type', 'code');
		u.searchParams.set('scope', SCOPES.join(' '));
		u.searchParams.set('access_type', 'offline');
		// Force consent so Google always returns a refresh token on reconnect.
		u.searchParams.set('prompt', 'consent');
		u.searchParams.set('include_granted_scopes', 'true');
		u.searchParams.set('state', state);
		return u.toString();
	},
	exchangeCode(cfg, code) {
		return tokenRequest({
			grant_type: 'authorization_code',
			code,
			redirect_uri: cfg.redirectUri,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret
		});
	},
	refresh(cfg, refreshToken) {
		return tokenRequest({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret
		});
	},
	async account(token) {
		// The primary calendar's id is the account email.
		const primary = await call<{ id: string }>(token, '/calendars/primary');
		return { login: primary.id, avatarUrl: null };
	}
};
