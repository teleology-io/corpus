import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray, sql as dsql } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import {
	fetchIcal,
	icalCalendarId,
	icalPollInterval,
	parseIcal,
	type IcalCalendar,
	type IcalEvent,
	type IcalFeed
} from '@corpus/core/integrations';
import { personalWorkspace, type Conn, type SyncResult } from './integrations';

const { calendar, event, eventAttendee, eventOverride, user } = schema;
type Calendar = typeof calendar.$inferSelect;

/** Same reach as the OAuth sync: past one-off events older than this aren't mirrored. */
const BACKFILL_DAYS = 90;
/** Bump when the mapping changes so already-synced events are rewritten on the next poll. */
const SYNC_VERSION = '2';
const COLORS = ['#2C87F2', '#30A46C', '#8E4EC6', '#F5A524', '#E93D82', '#0EA5A4'];

const hash = (parts: string[]) => createHash('sha256').update(parts.join('|')).digest('hex');

/** Decrypted access_token of an `ical` connection. */
export function icalFeeds(token: string): IcalFeed[] {
	try {
		return (JSON.parse(token) as { feeds?: IcalFeed[] }).feeds ?? [];
	} catch {
		return [];
	}
}

/**
 * Read-only sync of Google "secret address in iCal format" feeds. Each feed is a full snapshot,
 * so every poll reconciles the mirrored calendar against it: upsert what changed, drop what's gone.
 */
export async function syncIcal(c: Conn, token: string): Promise<SyncResult> {
	const intervalSec = icalPollInterval();
	const workspaceId = await personalWorkspace(c.userId);
	if (!workspaceId) throw new Error('No personal workspace to sync into');
	const [owner] = await db
		.select({ tz: user.timezone })
		.from(user)
		.where(eq(user.id, c.userId))
		.limit(1);
	const userTz = owner?.tz || 'UTC';

	const feeds = icalFeeds(token);
	// Removed feeds disappear (their mirrored events cascade with them).
	await db.delete(calendar).where(
		and(
			eq(calendar.connectionId, c.id),
			feeds.length
				? notInArray(
						calendar.externalId,
						feeds.map((f) => f.id)
					)
				: undefined
		)
	);
	if (!feeds.length) return { cursor: c.cursor, intervalSec, changes: 0 };

	const fetched = await Promise.allSettled(
		feeds.map(async (f) => ({
			feed: f,
			cal: parseIcal(await fetchIcal(f.url), userTz, icalCalendarId(f.url))
		}))
	);
	const ok = fetched.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
	const failed = fetched.flatMap((r, i) =>
		r.status === 'rejected'
			? [`${icalCalendarId(feeds[i]!.url) ?? 'Feed'}: ${(r.reason as Error).message}`]
			: []
	);

	let changes = 0;
	if (ok.length) {
		const links = await db
			.insert(calendar)
			.values(
				ok.map(({ feed, cal }) => ({
					workspaceId,
					name: cal.name || icalCalendarId(feed.url) || 'Google Calendar',
					color: COLORS[feeds.indexOf(feed) % COLORS.length]!,
					readOnly: true,
					connectionId: c.id,
					externalId: feed.id,
					createdBy: c.userId
				}))
			)
			// Keep the user's color choice; only follow renames.
			.onConflictDoUpdate({
				target: [calendar.connectionId, calendar.externalId],
				set: { name: dsql`excluded.name`, readOnly: true }
			})
			.returning();
		for (const link of links) {
			const parsed = ok.find((o) => o.feed.id === link.externalId)!.cal;
			changes += await reconcile(c, link, parsed);
		}
	}

	if (failed.length) throw new Error(failed.join(' · '));
	return { cursor: c.cursor, intervalSec, changes };
}

async function reconcile(c: Conn, cal: Calendar, feed: IcalCalendar): Promise<number> {
	const cutoff = Date.now() - BACKFILL_DAYS * 86_400_000;
	const instancesByUid = new Map<string, IcalEvent[]>();
	for (const e of feed.events)
		if (e.recurrenceId) instancesByUid.set(e.uid, [...(instancesByUid.get(e.uid) ?? []), e]);
	const masters = new Map<string, IcalEvent>();
	for (const e of feed.events)
		if (!e.recurrenceId && !e.cancelled && (e.fields.rrule || e.fields.endsAt.getTime() >= cutoff))
			masters.set(e.uid, e);

	// Fingerprint master + its instances so one etag covers the whole series.
	const etags = new Map(
		[...masters].map(([uid, m]) => [
			uid,
			hash([
				SYNC_VERSION,
				m.hash,
				...(instancesByUid.get(uid) ?? []).map((i) => i.hash).sort()
			]).slice(0, 32)
		])
	);
	const feedHash = hash([...etags].map(([uid, t]) => `${uid}:${t}`).sort());
	if (cal.syncToken === feedHash) return 0;

	const existing = await db
		.select({ id: event.id, externalId: event.externalId, externalEtag: event.externalEtag })
		.from(event)
		.where(eq(event.calendarId, cal.id));
	const byUid = new Map(existing.map((e) => [e.externalId!, e]));
	let changes = 0;

	for (const [uid, m] of masters) {
		const etag = etags.get(uid)!;
		const local = byUid.get(uid);
		if (local?.externalEtag === etag) continue;
		const instances = instancesByUid.get(uid) ?? [];
		const f = m.fields;
		const exdates = uniqueDates([
			...f.exdates,
			...instances.filter((i) => i.cancelled).map((i) => i.recurrenceId!)
		]);
		const values = {
			title: f.title,
			description: f.description,
			location: f.location,
			startsAt: f.startsAt,
			endsAt: f.endsAt,
			allDay: f.allDay,
			timezone: f.timezone,
			rrule: f.rrule,
			exdates,
			reminders: f.reminders.length ? f.reminders : [10],
			externalEtag: etag,
			externalMeta: f.meta,
			syncDirty: false
		};
		const [row] = local
			? await db.update(event).set(values).where(eq(event.id, local.id)).returning({ id: event.id })
			: await db
					.insert(event)
					.values({
						...values,
						workspaceId: cal.workspaceId,
						calendarId: cal.id,
						color: cal.color,
						externalId: uid,
						createdBy: c.userId
					})
					.returning({ id: event.id });
		const eventId = row!.id;

		await db.delete(eventAttendee).where(eq(eventAttendee.eventId, eventId));
		if (f.attendees.length)
			await db
				.insert(eventAttendee)
				.values(f.attendees.map((a) => ({ eventId, email: a.email, name: a.name, rsvp: a.rsvp })));

		await db.delete(eventOverride).where(eq(eventOverride.eventId, eventId));
		const edited = f.rrule ? instances.filter((i) => !i.cancelled) : [];
		if (edited.length)
			await db.insert(eventOverride).values(
				edited.map((i) => ({
					eventId,
					originalStart: i.recurrenceId!,
					patch: {
						title: i.fields.title,
						description: i.fields.description,
						location: i.fields.location,
						startsAt: i.fields.startsAt.toISOString(),
						endsAt: i.fields.endsAt.toISOString()
					}
				}))
			);
		changes++;
	}

	const gone = existing.filter((e) => !masters.has(e.externalId!)).map((e) => e.id);
	if (gone.length) {
		await db.delete(event).where(inArray(event.id, gone));
		changes += gone.length;
	}

	await db.update(calendar).set({ syncToken: feedHash }).where(eq(calendar.id, cal.id));
	return changes;
}

function uniqueDates(list: Date[]) {
	const seen = new Set<number>();
	return list.filter((d) => !seen.has(d.getTime()) && (seen.add(d.getTime()), true));
}
