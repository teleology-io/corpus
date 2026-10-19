import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { notify } from '@corpus/db/notify';
import {
	addDaysToDate,
	atLocal,
	describeCycle,
	doseOccurrences,
	expand,
	localDate,
	phaseOn,
	type NotificationInput
} from '@corpus/core';

const MIN = 60_000;
/** Look back this far each tick so a missed/late tick still fires (dedupe keys prevent repeats). */
const LOOKBACK = 10 * MIN;
const MISSED_AFTER = 2 * 60 * MIN;
const MAX_EVENT_OFFSET = 14 * 24 * 60 * MIN;

const fmt = (d: Date, tz: string) =>
	new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(d);

function offsetLabel(min: number) {
	if (min === 0) return 'now';
	if (min < 60) return `in ${min} min`;
	if (min < 1440) return `in ${min / 60} hour${min === 60 ? '' : 's'}`;
	return `in ${min / 1440} day${min === 1440 ? '' : 's'}`;
}

async function eventReminders(now: Date): Promise<NotificationInput[]> {
	const from = new Date(now.getTime() - LOOKBACK);
	const rows = await db
		.select()
		.from(schema.event)
		.where(
			and(
				isNull(schema.event.deletedAt),
				lt(schema.event.startsAt, new Date(now.getTime() + MAX_EVENT_OFFSET)),
				or(isNotNull(schema.event.rrule), gte(schema.event.startsAt, from))
			)
		);
	const withReminders = rows.filter((r) => r.reminders.length);
	if (!withReminders.length) return [];
	const [attendees, overrides] = await Promise.all([
		db
			.select()
			.from(schema.eventAttendee)
			.where(
				inArray(
					schema.eventAttendee.eventId,
					withReminders.map((r) => r.id)
				)
			),
		db
			.select()
			.from(schema.eventOverride)
			.where(
				inArray(
					schema.eventOverride.eventId,
					withReminders.map((r) => r.id)
				)
			)
	]);

	const out: NotificationInput[] = [];
	for (const ev of withReminders) {
		const maxOffset = Math.max(...ev.reminders) * MIN;
		const occs = expand(
			ev,
			from,
			new Date(now.getTime() + maxOffset + 1),
			overrides.filter((o) => o.eventId === ev.id)
		);
		const recipients = new Set<string>(
			[
				ev.createdBy,
				...attendees
					.filter((a) => a.eventId === ev.id && a.rsvp !== 'declined')
					.map((a) => a.userId)
			].filter((x): x is string => !!x)
		);
		for (const occ of occs) {
			for (const offset of ev.reminders) {
				const fireAt = occ.start.getTime() - offset * MIN;
				if (fireAt < from.getTime() || fireAt > now.getTime()) continue;
				const title = occ.patch?.title ?? ev.title;
				for (const userId of recipients) {
					out.push({
						userId,
						workspaceId: ev.workspaceId,
						type: 'event_starting',
						title: `${title} — ${offsetLabel(offset)}`,
						body: `${fmt(occ.start, ev.timezone)}${ev.location ? ` · ${ev.location}` : ''}`,
						href: `/calendar?event=${ev.id}`,
						sourceType: 'event',
						sourceId: ev.id,
						dedupeKey: `event_starting:${ev.id}:${occ.originalStart.toISOString()}:${offset}`
					});
				}
			}
		}
	}
	return out;
}

async function reminderDue(now: Date): Promise<NotificationInput[]> {
	const from = new Date(now.getTime() - LOOKBACK);
	const rows = await db
		.select()
		.from(schema.reminder)
		.where(and(eq(schema.reminder.active, true), lte(schema.reminder.startsAt, now)));
	return rows.flatMap((r) =>
		expand({ ...r, endsAt: r.startsAt }, from, new Date(now.getTime() + 1)).map((o) => ({
			userId: r.userId,
			workspaceId: r.workspaceId,
			type: 'reminder_due' as const,
			title: r.title,
			body: r.notes,
			href: '/dashboard',
			sourceType: 'reminder',
			sourceId: r.id,
			dedupeKey: `reminder_due:${r.id}:${o.start.toISOString()}`
		}))
	);
}

async function cycleNotifications(now: Date): Promise<NotificationInput[]> {
	const cycles = await db.select().from(schema.cycle).where(isNull(schema.cycle.pausedAt));
	if (!cycles.length) return [];
	const out: NotificationInput[] = [];
	const missedFrom = new Date(now.getTime() - MISSED_AFTER - LOOKBACK);
	const missedTo = new Date(now.getTime() - MISSED_AFTER);
	const logs = await db
		.select()
		.from(schema.doseLog)
		.where(
			and(
				inArray(
					schema.doseLog.cycleId,
					cycles.map((c) => c.id)
				),
				gte(schema.doseLog.scheduledFor, missedFrom)
			)
		);
	const logged = new Set(logs.map((l) => `${l.cycleId}:${l.scheduledFor.toISOString()}`));

	for (const c of cycles) {
		const def = { ...c, doseTimes: c.doseTimes.map((t) => t.slice(0, 5)) };
		for (const at of doseOccurrences(
			def,
			new Date(now.getTime() - LOOKBACK),
			new Date(now.getTime() + 1)
		)) {
			if (logged.has(`${c.id}:${at.toISOString()}`)) continue;
			out.push({
				userId: c.userId,
				workspaceId: c.workspaceId,
				type: 'dose_due',
				title: `Time to take ${c.name}`,
				body: c.doseLabel ?? `${fmt(at, c.timezone)} dose`,
				href: '/dashboard',
				sourceType: 'cycle',
				sourceId: c.id,
				dedupeKey: `dose_due:${c.id}:${at.toISOString()}`,
				data: { at: at.toISOString() }
			});
		}
		for (const at of doseOccurrences(def, missedFrom, missedTo)) {
			if (logged.has(`${c.id}:${at.toISOString()}`)) continue;
			out.push({
				userId: c.userId,
				workspaceId: c.workspaceId,
				type: 'dose_missed',
				title: `Missed dose: ${c.name}`,
				body: `Scheduled for ${fmt(at, c.timezone)} — log it on your dashboard`,
				href: '/dashboard',
				sourceType: 'cycle',
				sourceId: c.id,
				dedupeKey: `dose_missed:${c.id}:${at.toISOString()}`
			});
		}
		// Phase change: announced from 7am local on the first day of a new phase.
		const today = localDate(now, c.timezone);
		if (now >= atLocal(today, '07:00', c.timezone)) {
			const p = phaseOn(def, today);
			const y = phaseOn(def, addDaysToDate(today, -1));
			if (
				(p.status === 'on' || p.status === 'off') &&
				p.dayOfPhase === 1 &&
				y.status !== 'not_started'
			) {
				out.push({
					userId: c.userId,
					workspaceId: c.workspaceId,
					type: 'cycle_phase',
					title:
						p.status === 'on'
							? `${c.name}: on phase starts today`
							: `${c.name}: break starts today`,
					body: `${describeCycle(c)} · ${p.phaseLength} days${p.status === 'on' ? ` · cycle ${p.cycleNumber}` : ''}`,
					href: `/cycles/${c.id}`,
					sourceType: 'cycle',
					sourceId: c.id,
					dedupeKey: `cycle_phase:${c.id}:${today}`
				});
			}
		}
	}
	return out;
}

async function tasksDue(now: Date): Promise<NotificationInput[]> {
	const rows = await db
		.select()
		.from(schema.task)
		.where(
			and(
				isNull(schema.task.completedAt),
				eq(schema.task.dueAllDay, false),
				gte(schema.task.dueAt, new Date(now.getTime() - LOOKBACK)),
				lte(schema.task.dueAt, now)
			)
		);
	return rows
		.filter((t) => t.assigneeId ?? t.createdBy)
		.map((t) => ({
			userId: (t.assigneeId ?? t.createdBy)!,
			workspaceId: t.workspaceId,
			type: 'task_due' as const,
			title: `Due now: ${t.title}`,
			href: '/dashboard',
			sourceType: 'task',
			sourceId: t.id,
			dedupeKey: `task_due:${t.id}:${t.dueAt!.toISOString()}`
		}));
}

/** Morning digest at 07:00 local for users who opted in. */
async function digests(now: Date): Promise<NotificationInput[]> {
	const rows = await db
		.select({ userId: schema.user.id, tz: schema.user.timezone, name: schema.user.name })
		.from(schema.notificationSettings)
		.innerJoin(schema.user, eq(schema.notificationSettings.userId, schema.user.id))
		.where(eq(schema.notificationSettings.dailyDigest, true));
	const out: NotificationInput[] = [];
	for (const u of rows) {
		const tz = u.tz || 'UTC';
		const today = localDate(now, tz);
		const sendAt = atLocal(today, '07:00', tz);
		if (now < sendAt || now.getTime() - sendAt.getTime() > LOOKBACK) continue;
		const dayEnd = atLocal(addDaysToDate(today, 1), '00:00', tz);
		const [tasks, events] = await Promise.all([
			db
				.select({ title: schema.task.title })
				.from(schema.task)
				.where(
					and(
						isNull(schema.task.completedAt),
						or(
							eq(schema.task.assigneeId, u.userId),
							and(isNull(schema.task.assigneeId), eq(schema.task.createdBy, u.userId))
						),
						lt(schema.task.dueAt, dayEnd)
					)
				),
			db
				.select({ title: schema.event.title, startsAt: schema.event.startsAt })
				.from(schema.event)
				.where(
					and(
						isNull(schema.event.deletedAt),
						eq(schema.event.createdBy, u.userId),
						gte(schema.event.startsAt, sendAt),
						lt(schema.event.startsAt, dayEnd)
					)
				)
		]);
		const lines = [
			...events.map((e) => `• ${fmt(e.startsAt, tz)} ${e.title}`),
			...tasks.map((t) => `☐ ${t.title}`)
		];
		out.push({
			userId: u.userId,
			type: 'daily_digest',
			title: `Your day: ${events.length} appointment${events.length === 1 ? '' : 's'}, ${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
			body: lines.join('\n') || 'Nothing scheduled — enjoy the day.',
			href: '/dashboard',
			dedupeKey: `daily_digest:${today}`
		});
	}
	return out;
}

export async function tick(now = new Date()) {
	const batches = await Promise.allSettled([
		eventReminders(now),
		reminderDue(now),
		cycleNotifications(now),
		tasksDue(now),
		digests(now)
	]);
	const inputs: NotificationInput[] = [];
	for (const b of batches) {
		if (b.status === 'fulfilled') inputs.push(...b.value);
		else console.error('[tick] source failed', b.reason);
	}
	const inserted = await notify(inputs);
	if (inserted.length) console.log(`[tick] ${inserted.length} notification(s)`);
}
