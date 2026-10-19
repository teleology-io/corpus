import { and, eq, inArray, notInArray, sql as dsql } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { notify } from '@corpus/db/notify';
import { localDate, type NotificationInput } from '@corpus/core';
import {
	GoogleApiError,
	ProviderAuthError,
	fromGoogle,
	gcal,
	googleInstant,
	instanceId,
	toGoogle,
	type GCalendar,
	type GEvent
} from '@corpus/core/integrations';
import { personalWorkspace, type Conn, type SyncResult } from './integrations';

const { calendar, event, eventAttendee, eventOverride, integrationConnection, user } = schema;
type Calendar = typeof calendar.$inferSelect;
type EventRow = typeof event.$inferSelect;

/** How far back the first full sync reaches. Recurring series that are still running come too. */
const BACKFILL_DAYS = 90;

const fmt = (d: Date, tz: string, allDay: boolean) =>
	new Intl.DateTimeFormat('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(allDay ? {} : { hour: 'numeric', minute: '2-digit' }),
		timeZone: tz
	}).format(d);

/**
 * Two-way Google Calendar sync for one connection:
 *  1. mirror the selected Google calendars as Corpus calendars in the personal workspace,
 *  2. push local edits (events flagged sync_dirty),
 *  3. pull remote changes incrementally with Google sync tokens.
 * Conflicts: a locally dirty event wins until it's pushed; otherwise Google wins.
 */
export async function syncGoogle(c: Conn, token: string): Promise<SyncResult> {
	const workspaceId = await personalWorkspace(c.userId);
	if (!workspaceId) throw new Error('No personal workspace to sync into');
	const [owner] = await db
		.select({ tz: user.timezone })
		.from(user)
		.where(eq(user.id, c.userId))
		.limit(1);
	const userTz = owner?.tz || 'UTC';

	const remote = await gcal.calendars(token);
	let selected = c.settings.calendars;
	if (!selected) {
		selected = remote.filter((r) => r.primary).map((r) => r.id);
		await db
			.update(integrationConnection)
			.set({ settings: { ...c.settings, calendars: selected } })
			.where(eq(integrationConnection.id, c.id));
	}
	const wanted = remote.filter((r) => selected.includes(r.id));

	// Unselected calendars disappear (their mirrored events cascade with them).
	await db.delete(calendar).where(
		and(
			eq(calendar.connectionId, c.id),
			wanted.length
				? notInArray(
						calendar.externalId,
						wanted.map((w) => w.id)
					)
				: undefined
		)
	);
	if (!wanted.length) return { cursor: c.cursor, intervalSec: 120, changes: 0 };

	const links = await db
		.insert(calendar)
		.values(
			wanted.map((r) => ({
				workspaceId,
				name: r.summaryOverride ?? r.summary,
				color: r.backgroundColor ?? '#2C87F2',
				readOnly: r.accessRole !== 'owner' && r.accessRole !== 'writer',
				connectionId: c.id,
				externalId: r.id,
				createdBy: c.userId
			}))
		)
		.onConflictDoUpdate({
			target: [calendar.connectionId, calendar.externalId],
			set: {
				name: dsql`excluded.name`,
				color: dsql`excluded.color`,
				readOnly: dsql`excluded.read_only`
			}
		})
		.returning();

	let changes = 0;
	for (const cal of links) {
		const meta = wanted.find((w) => w.id === cal.externalId)!;
		if (!cal.readOnly) changes += await push(token, cal);
		changes += await pull(token, c, cal, meta, userTz);
	}
	return { cursor: c.cursor, intervalSec: 60, changes };
}

// ---------------------------------------------------------------------------
// push: Corpus → Google
// ---------------------------------------------------------------------------

async function push(token: string, cal: Calendar): Promise<number> {
	const dirty = await db
		.select()
		.from(event)
		.where(and(eq(event.calendarId, cal.id), eq(event.syncDirty, true)));
	let pushed = 0;
	for (const e of dirty) {
		try {
			await pushOne(token, cal, e);
			pushed++;
		} catch (err) {
			if (err instanceof ProviderAuthError) throw err;
			if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) {
				// Gone remotely: forget the link so the next push recreates it.
				await db
					.update(event)
					.set({ externalId: null, externalEtag: null })
					.where(eq(event.id, e.id));
			}
			console.error(`[gcal] push ${e.id}: ${(err as Error).message}`);
		}
	}
	return pushed;
}

/** Clear the dirty flag only if nobody edited the row while we were talking to Google. */
const settled = (e: EventRow) =>
	dsql`case when date_trunc('milliseconds', ${event.updatedAt}) = ${e.updatedAt} then false else true end`;

async function pushOne(token: string, cal: Calendar, e: EventRow) {
	const calId = cal.externalId!;
	if (e.deletedAt) {
		if (e.externalId) await gcal.remove(token, calId, e.externalId);
		// Trashed locally: unlink, so restoring from trash creates a fresh Google event.
		await db
			.update(event)
			.set({ externalId: null, externalEtag: null, syncDirty: settled(e) })
			.where(eq(event.id, e.id));
		return;
	}

	const attendees = await db
		.select({ email: eventAttendee.email, name: eventAttendee.name, userEmail: user.email })
		.from(eventAttendee)
		.leftJoin(user, eq(eventAttendee.userId, user.id))
		.where(eq(eventAttendee.eventId, e.id));
	const body = toGoogle({
		...e,
		attendees: attendees
			.map((a) => ({ email: (a.email ?? a.userEmail ?? '').toLowerCase(), name: a.name }))
			.filter((a) => a.email)
	});
	const saved = e.externalId
		? await gcal.patch(token, calId, e.externalId, body)
		: await gcal.insert(token, calId, body);

	// Single-occurrence edits become instance exceptions on Google's side.
	if (e.rrule) {
		const overrides = await db.select().from(eventOverride).where(eq(eventOverride.eventId, e.id));
		for (const o of overrides) {
			if (o.patch.cancelled) continue;
			const tz = e.timezone;
			const time = (iso: string | undefined) =>
				iso
					? e.allDay
						? { date: localDate(new Date(iso), tz) }
						: { dateTime: iso, timeZone: tz }
					: undefined;
			await gcal
				.patch(token, calId, instanceId(saved.id, o.originalStart, e.allDay, tz), {
					...(o.patch.title !== undefined && { summary: o.patch.title }),
					...(o.patch.description !== undefined && { description: o.patch.description ?? '' }),
					...(o.patch.location !== undefined && { location: o.patch.location ?? '' }),
					start: time(o.patch.startsAt),
					end: time(o.patch.endsAt)
				})
				.catch((err) => {
					if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
				});
		}
	}

	await db
		.update(event)
		.set({
			externalId: saved.id,
			externalEtag: saved.etag ?? null,
			externalMeta: {
				url: saved.htmlLink ?? null,
				meetUrl: saved.hangoutLink ?? null,
				organizer: saved.organizer?.displayName ?? saved.organizer?.email ?? null,
				organizerSelf: saved.organizer?.self ?? true
			},
			syncDirty: settled(e)
		})
		.where(eq(event.id, e.id));
}

// ---------------------------------------------------------------------------
// pull: Google → Corpus
// ---------------------------------------------------------------------------

async function fetchChanges(token: string, cal: Calendar) {
	const timeMin = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
	if (cal.syncToken) {
		try {
			return {
				...(await gcal.events(token, cal.externalId!, { syncToken: cal.syncToken })),
				full: false
			};
		} catch (e) {
			// 410 Gone: sync token expired — start over with a full sync.
			if (!(e instanceof GoogleApiError && e.status === 410)) throw e;
		}
	}
	return { ...(await gcal.events(token, cal.externalId!, { timeMin })), full: true };
}

async function pull(
	token: string,
	c: Conn,
	cal: Calendar,
	meta: GCalendar,
	userTz: string
): Promise<number> {
	const initial = !cal.syncToken;
	const { events, nextSyncToken, full } = await fetchChanges(token, cal);
	const calTz = meta.timeZone ?? userTz;
	const defaults = (meta.defaultReminders ?? []).map((r) => r.minutes);
	const notes: NotificationInput[] = [];
	const shouldNotify = !initial && c.settings.notify !== false;
	const link = (id: string, at: Date) => `/calendar?date=${localDate(at, userTz)}&event=${id}`;

	const masters = events.filter((e) => !e.recurringEventId);
	const instances = events.filter((e) => e.recurringEventId);
	const ids = [
		...new Set([...masters.map((e) => e.id), ...instances.map((e) => e.recurringEventId!)])
	];
	const existing = ids.length
		? await db
				.select()
				.from(event)
				.where(and(eq(event.calendarId, cal.id), inArray(event.externalId, ids)))
		: [];
	const byExternal = new Map(existing.map((e) => [e.externalId!, e]));
	let changes = 0;

	for (const g of masters) {
		const local = byExternal.get(g.id);
		if (g.status === 'cancelled') {
			if (!local || local.syncDirty) continue;
			await db.delete(event).where(eq(event.id, local.id));
			byExternal.delete(g.id);
			changes++;
			if (shouldNotify && local.externalMeta?.organizerSelf === false)
				notes.push({
					userId: c.userId,
					workspaceId: cal.workspaceId,
					type: 'calendar_change',
					title: `Cancelled: ${local.title}`,
					body: `${fmt(local.startsAt, userTz, local.allDay)} · ${local.externalMeta.organizer ?? 'Organizer'} cancelled this event`,
					href: '/calendar',
					sourceType: 'event',
					sourceId: local.id,
					dedupeKey: `calendar_change:${local.id}:cancelled`
				});
			continue;
		}
		if (local?.syncDirty) continue; // local edit wins; it'll be pushed next round
		if (local && local.externalEtag && local.externalEtag === g.etag) continue;

		const f = fromGoogle(g, calTz, defaults);
		const values = {
			title: f.title,
			description: f.description,
			location: f.location,
			startsAt: f.startsAt,
			endsAt: f.endsAt,
			allDay: f.allDay,
			timezone: f.timezone,
			rrule: f.rrule,
			reminders: f.reminders,
			externalEtag: g.etag ?? null,
			externalMeta: f.meta,
			syncDirty: false
		};
		let row: EventRow;
		if (local) {
			// Cancelled instances arrive once as their own items, so keep exdates we already know.
			const exdates = uniqueDates([...local.exdates, ...f.exdates]);
			[row] = (await db
				.update(event)
				.set({ ...values, exdates })
				.where(eq(event.id, local.id))
				.returning()) as [EventRow];
			const moved =
				local.startsAt.getTime() !== f.startsAt.getTime() ||
				local.endsAt.getTime() !== f.endsAt.getTime();
			if (shouldNotify && moved && !f.meta.organizerSelf)
				notes.push({
					userId: c.userId,
					workspaceId: cal.workspaceId,
					type: 'calendar_change',
					title: `Moved: ${f.title}`,
					body: `Now ${fmt(f.startsAt, userTz, f.allDay)} (was ${fmt(local.startsAt, userTz, local.allDay)})`,
					href: link(row.id, f.startsAt),
					sourceType: 'event',
					sourceId: row.id,
					dedupeKey: `calendar_change:${row.id}:${f.startsAt.toISOString()}:${f.endsAt.toISOString()}`
				});
		} else {
			[row] = (await db
				.insert(event)
				.values({
					...values,
					exdates: f.exdates,
					workspaceId: cal.workspaceId,
					calendarId: cal.id,
					color: cal.color,
					externalId: g.id,
					createdBy: c.userId
				})
				.returning()) as [EventRow];
			const invited = g.attendees?.some((a) => a.self) && !f.meta.organizerSelf;
			if (shouldNotify && invited)
				notes.push({
					userId: c.userId,
					workspaceId: cal.workspaceId,
					type: 'calendar_invite',
					title: `${f.meta.organizer ?? 'Someone'} invited you to “${f.title}”`,
					body: `${fmt(f.startsAt, userTz, f.allDay)}${f.location ? ` · ${f.location}` : ''}`,
					href: link(row.id, f.startsAt),
					sourceType: 'event',
					sourceId: row.id,
					dedupeKey: `calendar_invite:${cal.id}:${g.id}`
				});
		}
		byExternal.set(g.id, row);
		await replaceAttendees(row.id, f.attendees);
		changes++;
	}

	for (const g of instances) {
		const master = byExternal.get(g.recurringEventId!);
		if (!master || master.syncDirty || !g.originalStartTime) continue;
		const originalStart = googleInstant(g.originalStartTime, master.timezone);
		await db
			.delete(eventOverride)
			.where(
				and(eq(eventOverride.eventId, master.id), eq(eventOverride.originalStart, originalStart))
			);
		if (g.status === 'cancelled') {
			const exdates = uniqueDates([...master.exdates, originalStart]);
			await db.update(event).set({ exdates }).where(eq(event.id, master.id));
			master.exdates = exdates;
		} else {
			await db.insert(eventOverride).values({
				eventId: master.id,
				originalStart,
				patch: instancePatch(g, master)
			});
		}
		changes++;
	}

	await db.update(calendar).set({ syncToken: nextSyncToken }).where(eq(calendar.id, cal.id));
	if (full && !initial) console.log(`[gcal] ${cal.id}: sync token expired, did a full resync`);
	await notify(notes);
	return changes;
}

function instancePatch(g: GEvent, master: EventRow) {
	const tz = g.start?.timeZone ?? master.timezone;
	return {
		...(g.summary !== undefined && { title: g.summary }),
		...(g.description !== undefined && { description: g.description }),
		...(g.location !== undefined && { location: g.location }),
		...(g.start && { startsAt: googleInstant(g.start, tz).toISOString() }),
		...(g.end && { endsAt: googleInstant(g.end, tz).toISOString() })
	};
}

function uniqueDates(list: Date[]) {
	const seen = new Set<number>();
	return list.filter((d) => !seen.has(d.getTime()) && (seen.add(d.getTime()), true));
}

async function replaceAttendees(
	eventId: string,
	list: { email: string; name: string | null; rsvp: string }[]
) {
	await db.delete(eventAttendee).where(eq(eventAttendee.eventId, eventId));
	if (!list.length) return;
	// Email-only on purpose: linking Corpus users would surface this copy in their calendars
	// too (duplicating their own synced copy).
	await db
		.insert(eventAttendee)
		.values(list.map((a) => ({ eventId, email: a.email, name: a.name, rsvp: a.rsvp })));
}
