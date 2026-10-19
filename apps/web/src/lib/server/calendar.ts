import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@corpus/db';
import { notify } from '@corpus/db/notify';
import { expand, presetRule, truncateRule, type Override } from '@corpus/core';
import { randomToken } from '@corpus/core/crypto';
import type { CalendarDTO, CategoryDTO, OccurrenceDTO, Person } from '#lib/types.js';
import type { Ctx } from './ctx.js';
import { requestPoll } from './integrations.js';

type EventRow = typeof schema.event.$inferSelect;

const {
	event,
	eventOverride,
	eventAttendee,
	category,
	calendar,
	user,
	member,
	integrationConnection
} = schema;

// ---------- validation ----------

export const repeatSchema = z.enum([
	'none',
	'daily',
	'weekdays',
	'weekly',
	'biweekly',
	'monthly',
	'yearly',
	'custom'
]);

export const eventInput = z.object({
	title: z.string().trim().min(1).max(200),
	description: z.string().max(5000).nullish(),
	location: z.string().max(300).nullish(),
	categoryId: z.uuid().nullish(),
	calendarId: z.uuid().nullish(),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
	opacity: z.number().int().min(10).max(100).default(100),
	start: z.iso.datetime({ offset: true }),
	end: z.iso.datetime({ offset: true }),
	allDay: z.boolean().default(false),
	timezone: z.string().default('UTC'),
	repeat: repeatSchema.default('none'),
	rrule: z.string().max(500).nullish(),
	until: z.iso.datetime({ offset: true }).nullish(),
	reminders: z
		.array(
			z
				.number()
				.int()
				.min(0)
				.max(60 * 24 * 14)
		)
		.max(5)
		.default([10]),
	attendees: z
		.array(
			z.object({
				userId: z.string().nullish(),
				email: z.email().nullish(),
				name: z.string().nullish()
			})
		)
		.max(100)
		.default([]),
	noteId: z.uuid().nullish()
});
export type EventInput = z.infer<typeof eventInput>;

export const eventPatch = eventInput.partial().extend({
	scope: z.enum(['this', 'following', 'all']).default('all'),
	originalStart: z.iso.datetime({ offset: true }).nullish()
});

function ruleFor(input: Pick<EventInput, 'repeat' | 'rrule' | 'until' | 'timezone'>, start: Date) {
	if (input.repeat === 'custom') return input.rrule?.replace(/^RRULE:/i, '') || null;
	return presetRule(
		input.repeat ?? 'none',
		start,
		input.timezone ?? 'UTC',
		input.until ? new Date(input.until) : null
	);
}

// ---------- access ----------

async function workspaceIdsFor(userId: string) {
	const rows = await db
		.select({ id: member.organizationId })
		.from(member)
		.where(eq(member.userId, userId));
	return rows.map((r) => r.id);
}

/** Load an event the user can edit (member of its workspace, calendar not read-only). */
export async function editableEvent(ctx: Ctx, eventId: string): Promise<EventRow> {
	const [found] = await db
		.select({ row: event, readOnly: calendar.readOnly })
		.from(event)
		.innerJoin(calendar, eq(event.calendarId, calendar.id))
		.where(eq(event.id, eventId))
		.limit(1);
	if (!found) error(404, 'Event not found');
	const ids = await workspaceIdsFor(ctx.userId);
	if (!ids.includes(found.row.workspaceId)) error(403, 'Not allowed');
	if (found.readOnly) error(403, 'This calendar is read-only');
	return found.row;
}

/**
 * Flag events that live in externally synced calendars (Google) for push and wake the
 * worker so the change reaches the provider within seconds.
 */
async function queueSync(eventIds: string[]) {
	if (!eventIds.length) return;
	const synced = db
		.select({ id: calendar.id })
		.from(calendar)
		.where(isNotNull(calendar.connectionId));
	const rows = await db
		.update(event)
		.set({ syncDirty: true })
		.where(and(inArray(event.id, eventIds), inArray(event.calendarId, synced)))
		.returning({ calendarId: event.calendarId });
	if (!rows.length) return;
	const conns = await db
		.selectDistinct({ id: calendar.connectionId })
		.from(calendar)
		.where(
			inArray(
				calendar.id,
				rows.map((r) => r.calendarId)
			)
		);
	for (const c of conns) if (c.id) await requestPoll(c.id);
}

// ---------- reads ----------

export async function listCategories(workspaceId: string): Promise<CategoryDTO[]> {
	return db
		.select({ id: category.id, name: category.name, icon: category.icon, color: category.color })
		.from(category)
		.where(eq(category.workspaceId, workspaceId))
		.orderBy(asc(category.position));
}

/** Calendars events can be created in (plus read-only mirrors, flagged). */
export async function listCalendars(workspaceId: string): Promise<CalendarDTO[]> {
	return db
		.select({
			id: calendar.id,
			name: calendar.name,
			color: calendar.color,
			isDefault: calendar.isDefault,
			readOnly: calendar.readOnly,
			provider: integrationConnection.provider,
			account: integrationConnection.accountLogin
		})
		.from(calendar)
		.leftJoin(integrationConnection, eq(calendar.connectionId, integrationConnection.id))
		.where(eq(calendar.workspaceId, workspaceId))
		.orderBy(desc(calendar.isDefault), asc(calendar.createdAt));
}

export async function defaultCalendar(workspaceId: string, userId: string) {
	const [cal] = await db
		.select()
		.from(calendar)
		.where(and(eq(calendar.workspaceId, workspaceId), isNull(calendar.connectionId)))
		.orderBy(desc(calendar.isDefault), asc(calendar.createdAt))
		.limit(1);
	if (cal) return cal;
	const [created] = await db
		.insert(calendar)
		.values({ workspaceId, name: 'Calendar', isDefault: true, createdBy: userId })
		.returning();
	return created!;
}

/** Event rows that might produce occurrences in [from, to) for this user. */
async function candidateEvents(ctx: Ctx, from: Date, to: Date, search?: string) {
	const attending = db
		.select({ id: eventAttendee.eventId })
		.from(eventAttendee)
		.where(eq(eventAttendee.userId, ctx.userId));
	return db
		.select()
		.from(event)
		.where(
			and(
				isNull(event.deletedAt),
				or(eq(event.workspaceId, ctx.workspaceId), inArray(event.id, attending)),
				lt(event.startsAt, to),
				or(isNotNull(event.rrule), gt(event.endsAt, from)),
				search ? ilike(event.title, `%${search}%`) : undefined
			)
		);
}

export async function listOccurrences(
	ctx: Ctx,
	from: Date,
	to: Date,
	opts: { search?: string } = {}
): Promise<OccurrenceDTO[]> {
	const rows = await candidateEvents(ctx, from, to, opts.search);
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const memberOf = new Set(await workspaceIdsFor(ctx.userId));

	const [overrides, attendees, categories, calendars] = await Promise.all([
		db.select().from(eventOverride).where(inArray(eventOverride.eventId, ids)),
		db
			.select({
				eventId: eventAttendee.eventId,
				userId: eventAttendee.userId,
				email: eventAttendee.email,
				name: eventAttendee.name,
				userName: user.name,
				userEmail: user.email,
				image: user.image
			})
			.from(eventAttendee)
			.leftJoin(user, eq(eventAttendee.userId, user.id))
			.where(inArray(eventAttendee.eventId, ids)),
		db
			.select({ id: category.id, name: category.name, icon: category.icon, color: category.color })
			.from(category)
			.where(
				inArray(
					category.id,
					rows.map((r) => r.categoryId).filter((c): c is string => !!c)
				)
			),
		db
			.select({
				id: calendar.id,
				readOnly: calendar.readOnly,
				provider: integrationConnection.provider
			})
			.from(calendar)
			.leftJoin(integrationConnection, eq(calendar.connectionId, integrationConnection.id))
			.where(inArray(calendar.id, [...new Set(rows.map((r) => r.calendarId))]))
	]);
	const calendarBy = new Map(calendars.map((c) => [c.id, c]));

	const overridesBy = new Map<string, Override[]>();
	for (const o of overrides) {
		const list = overridesBy.get(o.eventId) ?? [];
		list.push({ originalStart: o.originalStart, patch: o.patch });
		overridesBy.set(o.eventId, list);
	}
	const attendeesBy = new Map<string, Person[]>();
	for (const a of attendees) {
		const list = attendeesBy.get(a.eventId) ?? [];
		list.push({
			id: a.userId,
			name: a.userName ?? a.name ?? a.email ?? 'Guest',
			email: a.userEmail ?? a.email,
			image: a.image
		});
		attendeesBy.set(a.eventId, list);
	}
	const categoryBy = new Map(categories.map((c) => [c.id, c]));

	const out: OccurrenceDTO[] = [];
	for (const row of rows) {
		const cal = calendarBy.get(row.calendarId);
		for (const occ of expand(row, from, to, overridesBy.get(row.id))) {
			out.push({
				key: `${row.id}:${occ.originalStart.toISOString()}`,
				eventId: row.id,
				calendarId: row.calendarId,
				title: occ.patch?.title ?? row.title,
				description: occ.patch?.description !== undefined ? occ.patch.description : row.description,
				location: occ.patch?.location !== undefined ? occ.patch.location : row.location,
				color: occ.patch?.color ?? row.color,
				opacity: row.opacity,
				start: occ.start.toISOString(),
				end: occ.end.toISOString(),
				originalStart: occ.originalStart.toISOString(),
				allDay: row.allDay,
				recurring: occ.recurring,
				rrule: row.rrule,
				timezone: row.timezone,
				reminders: row.reminders,
				category: row.categoryId ? (categoryBy.get(row.categoryId) ?? null) : null,
				attendees: attendeesBy.get(row.id) ?? [],
				noteId: row.noteId,
				canEdit: memberOf.has(row.workspaceId) && !cal?.readOnly,
				external: cal?.provider
					? {
							provider: cal.provider,
							url: row.externalMeta?.url ?? null,
							meetUrl: row.externalMeta?.meetUrl ?? null,
							organizer: row.externalMeta?.organizerSelf
								? null
								: (row.externalMeta?.organizer ?? null)
						}
					: null
			});
		}
	}
	return out.sort((a, b) => a.start.localeCompare(b.start));
}

export async function listTrash(ctx: Ctx) {
	return db
		.select({
			id: event.id,
			title: event.title,
			color: event.color,
			startsAt: event.startsAt,
			endsAt: event.endsAt,
			rrule: event.rrule,
			deletedAt: event.deletedAt
		})
		.from(event)
		.where(and(eq(event.workspaceId, ctx.workspaceId), isNotNull(event.deletedAt)))
		.orderBy(desc(event.deletedAt))
		.limit(200);
}

// ---------- writes ----------

async function setAttendees(
	ctx: Ctx,
	eventId: string,
	title: string,
	list: EventInput['attendees']
) {
	const existing = await db.select().from(eventAttendee).where(eq(eventAttendee.eventId, eventId));
	const key = (a: { userId?: string | null; email?: string | null }) =>
		a.userId ?? a.email?.toLowerCase() ?? '';
	const wanted = new Map(list.filter((a) => a.userId || a.email).map((a) => [key(a), a]));
	const have = new Map(existing.map((a) => [key(a), a]));

	const removed = existing.filter((a) => !wanted.has(key(a)));
	if (removed.length)
		await db.delete(eventAttendee).where(
			inArray(
				eventAttendee.id,
				removed.map((r) => r.id)
			)
		);

	const added = [...wanted.entries()].filter(([k]) => !have.has(k)).map(([, a]) => a);
	if (added.length) {
		await db.insert(eventAttendee).values(
			added.map((a) => ({
				eventId,
				userId: a.userId ?? null,
				email: a.email?.toLowerCase() ?? null,
				name: a.name ?? null
			}))
		);
		await notify(
			added
				.filter((a): a is typeof a & { userId: string } => !!a.userId && a.userId !== ctx.userId)
				.map((a) => ({
					userId: a.userId,
					workspaceId: ctx.workspaceId,
					type: 'event_invite' as const,
					title: `${ctx.user.name} invited you to “${title}”`,
					href: `/calendar?event=${eventId}`,
					sourceType: 'event',
					sourceId: eventId,
					dedupeKey: `event_invite:${eventId}`
				}))
		);
	}
}

export async function createEvent(ctx: Ctx, input: EventInput) {
	const start = new Date(input.start);
	const end = new Date(input.end);
	if (end < start) error(400, 'End must be after start');
	const cal = input.calendarId
		? await writableCalendar(ctx, input.calendarId)
		: await defaultCalendar(ctx.workspaceId, ctx.userId);
	const [row] = await db
		.insert(event)
		.values({
			workspaceId: ctx.workspaceId,
			calendarId: cal.id,
			categoryId: input.categoryId ?? null,
			title: input.title,
			description: input.description ?? null,
			location: input.location ?? null,
			color: input.color,
			opacity: input.opacity,
			startsAt: start,
			endsAt: end,
			allDay: input.allDay,
			timezone: input.timezone,
			rrule: ruleFor(input, start),
			reminders: input.reminders,
			noteId: input.noteId ?? null,
			createdBy: ctx.userId
		})
		.returning();
	await setAttendees(ctx, row!.id, row!.title, input.attendees);
	await queueSync([row!.id]);
	return row!;
}

async function writableCalendar(ctx: Ctx, calendarId: string) {
	const [cal] = await db
		.select()
		.from(calendar)
		.where(and(eq(calendar.id, calendarId), eq(calendar.workspaceId, ctx.workspaceId)))
		.limit(1);
	if (!cal) error(404, 'Calendar not found');
	if (cal.readOnly) error(403, 'This calendar is read-only');
	return cal;
}

type Patch = z.infer<typeof eventPatch>;

function baseFields(p: Patch) {
	const out: Partial<typeof event.$inferInsert> = {};
	if (p.title !== undefined) out.title = p.title;
	if (p.description !== undefined) out.description = p.description ?? null;
	if (p.location !== undefined) out.location = p.location ?? null;
	if (p.categoryId !== undefined) out.categoryId = p.categoryId ?? null;
	if (p.color !== undefined) out.color = p.color;
	if (p.opacity !== undefined) out.opacity = p.opacity;
	if (p.allDay !== undefined) out.allDay = p.allDay;
	if (p.timezone !== undefined) out.timezone = p.timezone;
	if (p.reminders !== undefined) out.reminders = p.reminders;
	if (p.noteId !== undefined) out.noteId = p.noteId ?? null;
	return out;
}

export async function updateEvent(ctx: Ctx, eventId: string, patch: Patch) {
	const row = await editableEvent(ctx, eventId);
	const scope = row.rrule ? patch.scope : 'all';
	const originalStart = patch.originalStart ? new Date(patch.originalStart) : row.startsAt;
	const newStart = patch.start ? new Date(patch.start) : null;
	const newEnd = patch.end ? new Date(patch.end) : null;

	if (scope === 'this') {
		const occEnd = new Date(
			originalStart.getTime() + (row.endsAt.getTime() - row.startsAt.getTime())
		);
		const [existing] = await db
			.select()
			.from(eventOverride)
			.where(and(eq(eventOverride.eventId, row.id), eq(eventOverride.originalStart, originalStart)))
			.limit(1);
		const merged = {
			...(existing?.patch ?? {}),
			...(patch.title !== undefined && { title: patch.title }),
			...(patch.description !== undefined && { description: patch.description ?? null }),
			...(patch.location !== undefined && { location: patch.location ?? null }),
			...(patch.color !== undefined && { color: patch.color }),
			startsAt: (
				newStart ?? (existing?.patch.startsAt ? new Date(existing.patch.startsAt) : originalStart)
			).toISOString(),
			endsAt: (
				newEnd ?? (existing?.patch.endsAt ? new Date(existing.patch.endsAt) : occEnd)
			).toISOString()
		};
		if (existing)
			await db
				.update(eventOverride)
				.set({ patch: merged })
				.where(eq(eventOverride.id, existing.id));
		else await db.insert(eventOverride).values({ eventId: row.id, originalStart, patch: merged });
		await queueSync([row.id]);
		return row;
	}

	if (scope === 'following' && originalStart.getTime() !== row.startsAt.getTime()) {
		// Split the series: old one ends before this occurrence, new one starts here.
		await db
			.update(event)
			.set({ rrule: truncateRule(row.rrule!, originalStart) })
			.where(eq(event.id, row.id));
		const duration = row.endsAt.getTime() - row.startsAt.getTime();
		const start = newStart ?? originalStart;
		const end = newEnd ?? new Date(start.getTime() + duration);
		const nextRule =
			patch.repeat !== undefined
				? ruleFor(
						{
							repeat: patch.repeat,
							rrule: patch.rrule,
							until: patch.until,
							timezone: patch.timezone ?? row.timezone
						},
						start
					)
				: row.rrule!.replace(/;COUNT=\d+/, '');
		const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = row;
		const [created] = await db
			.insert(event)
			.values({
				...rest,
				...baseFields(patch),
				startsAt: start,
				endsAt: end,
				rrule: nextRule,
				exdates: row.exdates.filter((d) => d >= originalStart),
				// The new series is a new external event; the old one keeps its link.
				externalId: null,
				externalEtag: null,
				externalMeta: null,
				createdBy: ctx.userId
			})
			.returning();
		const attendees = await db
			.select()
			.from(eventAttendee)
			.where(eq(eventAttendee.eventId, row.id));
		if (attendees.length)
			await db
				.insert(eventAttendee)
				.values(attendees.map(({ id: _a, ...a }) => ({ ...a, eventId: created!.id })));
		if (patch.attendees) await setAttendees(ctx, created!.id, created!.title, patch.attendees);
		await queueSync([row.id, created!.id]);
		return created!;
	}

	// scope === 'all'
	const values = baseFields(patch);
	if (newStart || newEnd) {
		// Shift the whole series by the delta applied to the edited occurrence.
		const occDuration = row.endsAt.getTime() - row.startsAt.getTime();
		const startDelta = newStart ? newStart.getTime() - originalStart.getTime() : 0;
		const endTarget = newEnd
			? newEnd.getTime()
			: originalStart.getTime() + startDelta + occDuration;
		const newDuration = endTarget - (originalStart.getTime() + startDelta);
		values.startsAt = new Date(row.startsAt.getTime() + startDelta);
		values.endsAt = new Date(values.startsAt.getTime() + newDuration);
		if (row.rrule && startDelta !== 0)
			await db.delete(eventOverride).where(eq(eventOverride.eventId, row.id));
	}
	if (patch.repeat !== undefined) {
		values.rrule = ruleFor(
			{
				repeat: patch.repeat,
				rrule: patch.rrule,
				until: patch.until,
				timezone: patch.timezone ?? row.timezone
			},
			values.startsAt ?? row.startsAt
		);
	}
	const [updated] = await db.update(event).set(values).where(eq(event.id, row.id)).returning();
	if (patch.attendees) await setAttendees(ctx, row.id, updated!.title, patch.attendees);
	await queueSync([row.id]);
	return updated!;
}

export async function deleteEvent(
	ctx: Ctx,
	eventId: string,
	scope: 'this' | 'following' | 'all',
	originalStart?: string | null
) {
	const row = await editableEvent(ctx, eventId);
	const at = originalStart ? new Date(originalStart) : row.startsAt;
	if (
		!row.rrule ||
		scope === 'all' ||
		(scope === 'following' && at.getTime() === row.startsAt.getTime())
	) {
		await db.update(event).set({ deletedAt: new Date() }).where(eq(event.id, row.id));
	} else if (scope === 'this') {
		await db
			.update(event)
			.set({ exdates: [...row.exdates, at] })
			.where(eq(event.id, row.id));
	} else {
		await db
			.update(event)
			.set({ rrule: truncateRule(row.rrule, at) })
			.where(eq(event.id, row.id));
	}
	await queueSync([row.id]);
}

export async function restoreEvent(ctx: Ctx, eventId: string) {
	const row = await editableEvent(ctx, eventId);
	await db.update(event).set({ deletedAt: null }).where(eq(event.id, row.id));
	await queueSync([row.id]);
}

export async function purgeEvent(ctx: Ctx, eventId: string) {
	const row = await editableEvent(ctx, eventId);
	if (!row.deletedAt) error(400, 'Move to trash first');
	// The worker unlinks a trashed event once Google has deleted it; purging before
	// that would leave the Google copy behind.
	if (row.externalId)
		error(409, 'Still removing this event from Google Calendar — try again shortly');
	await db.delete(event).where(eq(event.id, row.id));
}

// ---------- export / feed ----------

export async function exportEvents(workspaceId: string) {
	return db
		.select()
		.from(event)
		.where(and(eq(event.workspaceId, workspaceId), isNull(event.deletedAt)))
		.orderBy(asc(event.startsAt));
}

export async function ensureFeedToken(ctx: Ctx) {
	const cal = await defaultCalendar(ctx.workspaceId, ctx.userId);
	if (cal.feedToken) return cal.feedToken;
	const token = randomToken();
	await db.update(calendar).set({ feedToken: token }).where(eq(calendar.id, cal.id));
	return token;
}

export async function calendarByFeedToken(token: string) {
	const [cal] = await db.select().from(calendar).where(eq(calendar.feedToken, token)).limit(1);
	return cal ?? null;
}

// ---------- categories ----------

export const categoryInput = z.object({
	name: z.string().trim().min(1).max(60),
	icon: z.string().max(40).default('calendar'),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/)
});

export async function createCategory(ctx: Ctx, input: z.infer<typeof categoryInput>) {
	const existing = await listCategories(ctx.workspaceId);
	const [row] = await db
		.insert(category)
		.values({ ...input, workspaceId: ctx.workspaceId, position: existing.length })
		.returning();
	return row!;
}

export async function updateCategory(
	ctx: Ctx,
	id: string,
	input: Partial<z.infer<typeof categoryInput>>
) {
	await db
		.update(category)
		.set(input)
		.where(and(eq(category.id, id), eq(category.workspaceId, ctx.workspaceId)));
}

export async function deleteCategory(ctx: Ctx, id: string) {
	await db
		.delete(category)
		.where(and(eq(category.id, id), eq(category.workspaceId, ctx.workspaceId)));
}
