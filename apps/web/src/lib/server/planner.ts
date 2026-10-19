import { error } from '@sveltejs/kit';
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql
} from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@corpus/db';
import { notify } from '@corpus/db/notify';
import { doseOccurrences, expand, phaseSegments, presetRule } from '@corpus/core';
import type { CycleBandDTO, DoseDTO, ReminderOccurrenceDTO, TaskDTO } from '#lib/types.js';
import type { Ctx } from './ctx.js';
import { membership } from './workspaces.js';

const { task, reminder, cycle, doseLog, user } = schema;

// ---------- tasks ----------

export const taskInput = z.object({
	title: z.string().trim().min(1).max(300),
	notes: z.string().max(5000).nullish(),
	dueAt: z.iso.datetime({ offset: true }).nullish(),
	dueAllDay: z.boolean().default(true),
	priority: z.number().int().min(0).max(3).default(0),
	assigneeId: z.string().nullish()
});

export const taskPatch = taskInput.partial().extend({ completed: z.boolean().optional() });

function taskDTO(
	row: typeof task.$inferSelect & { assigneeName?: string | null; assigneeImage?: string | null }
): TaskDTO {
	return {
		id: row.id,
		title: row.title,
		notes: row.notes,
		dueAt: row.dueAt?.toISOString() ?? null,
		dueAllDay: row.dueAllDay,
		priority: row.priority,
		completedAt: row.completedAt?.toISOString() ?? null,
		source: row.source,
		externalUrl: row.externalUrl,
		assignee: row.assigneeId
			? { id: row.assigneeId, name: row.assigneeName ?? 'Member', image: row.assigneeImage ?? null }
			: null
	};
}

const taskSelect = { ...getTableColumns(task), assigneeName: user.name, assigneeImage: user.image };

/** Tasks visible to the user: in the active workspace, either assigned to them or unassigned. */
function mine(ctx: Ctx) {
	return and(
		eq(task.workspaceId, ctx.workspaceId),
		or(isNull(task.assigneeId), eq(task.assigneeId, ctx.userId))
	);
}

export async function listTasks(
	ctx: Ctx,
	opts: {
		from?: Date;
		to?: Date;
		includeUndated?: boolean;
		includeOverdue?: boolean;
		completed?: boolean;
	}
) {
	const range =
		opts.from && opts.to
			? or(
					and(gte(task.dueAt, opts.from), lt(task.dueAt, opts.to)),
					opts.includeUndated ? and(isNull(task.dueAt), isNull(task.completedAt)) : undefined,
					opts.includeOverdue
						? and(lt(task.dueAt, opts.from), isNull(task.completedAt))
						: undefined,
					// Completed within the range even if due elsewhere — so "done today" shows up
					and(gte(task.completedAt, opts.from), lt(task.completedAt, opts.to))
				)
			: undefined;
	const rows = await db
		.select(taskSelect)
		.from(task)
		.leftJoin(user, eq(task.assigneeId, user.id))
		.where(
			and(
				mine(ctx),
				range,
				opts.completed === false
					? isNull(task.completedAt)
					: opts.completed
						? isNotNull(task.completedAt)
						: undefined
			)
		)
		.orderBy(asc(task.completedAt), desc(task.priority), asc(task.dueAt), asc(task.createdAt))
		.limit(500);
	return rows.map(taskDTO);
}

async function ownTask(ctx: Ctx, id: string) {
	const [row] = await db.select().from(task).where(eq(task.id, id)).limit(1);
	if (!row || !(await membership(ctx.userId, row.workspaceId))) error(404, 'Task not found');
	return row;
}

export async function createTask(ctx: Ctx, input: z.infer<typeof taskInput>) {
	const [row] = await db
		.insert(task)
		.values({
			workspaceId: ctx.workspaceId,
			title: input.title,
			notes: input.notes ?? null,
			dueAt: input.dueAt ? new Date(input.dueAt) : null,
			dueAllDay: input.dueAllDay,
			priority: input.priority,
			assigneeId: input.assigneeId ?? null,
			createdBy: ctx.userId
		})
		.returning();
	if (row!.assigneeId && row!.assigneeId !== ctx.userId) await notifyAssigned(ctx, row!);
	return row!;
}

async function notifyAssigned(ctx: Ctx, row: typeof task.$inferSelect) {
	await notify({
		userId: row.assigneeId!,
		workspaceId: row.workspaceId,
		type: 'task_assigned',
		title: `${ctx.user.name} assigned you “${row.title}”`,
		href: '/dashboard',
		sourceType: 'task',
		sourceId: row.id,
		dedupeKey: `task_assigned:${row.id}:${row.assigneeId}`
	});
}

export async function updateTask(ctx: Ctx, id: string, patch: z.infer<typeof taskPatch>) {
	const prev = await ownTask(ctx, id);
	const values: Partial<typeof task.$inferInsert> = {};
	if (patch.title !== undefined) values.title = patch.title;
	if (patch.notes !== undefined) values.notes = patch.notes ?? null;
	if (patch.dueAt !== undefined) values.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
	if (patch.dueAllDay !== undefined) values.dueAllDay = patch.dueAllDay;
	if (patch.priority !== undefined) values.priority = patch.priority;
	if (patch.assigneeId !== undefined) values.assigneeId = patch.assigneeId ?? null;
	if (patch.completed !== undefined) values.completedAt = patch.completed ? new Date() : null;
	const [row] = await db.update(task).set(values).where(eq(task.id, id)).returning();
	if (row!.assigneeId && row!.assigneeId !== prev.assigneeId && row!.assigneeId !== ctx.userId)
		await notifyAssigned(ctx, row!);
	return row!;
}

export async function deleteTask(ctx: Ctx, id: string) {
	await ownTask(ctx, id);
	await db.delete(task).where(eq(task.id, id));
}

/** Completed-task counts per local-day window. */
export async function completedBetween(ctx: Ctx, from: Date, to: Date) {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(task)
		.where(and(mine(ctx), gte(task.completedAt, from), lt(task.completedAt, to)));
	return row?.n ?? 0;
}

// ---------- reminders ----------

export const reminderInput = z.object({
	title: z.string().trim().min(1).max(200),
	notes: z.string().max(2000).nullish(),
	startsAt: z.iso.datetime({ offset: true }),
	timezone: z.string().default('UTC'),
	repeat: z
		.enum(['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'])
		.default('none'),
	active: z.boolean().default(true)
});

export async function listReminders(ctx: Ctx) {
	return db
		.select()
		.from(reminder)
		.where(and(eq(reminder.userId, ctx.userId), eq(reminder.workspaceId, ctx.workspaceId)))
		.orderBy(desc(reminder.active), asc(reminder.startsAt));
}

export async function createReminder(ctx: Ctx, input: z.infer<typeof reminderInput>) {
	const startsAt = new Date(input.startsAt);
	const [row] = await db
		.insert(reminder)
		.values({
			workspaceId: ctx.workspaceId,
			userId: ctx.userId,
			title: input.title,
			notes: input.notes ?? null,
			startsAt,
			timezone: input.timezone,
			rrule: presetRule(input.repeat, startsAt, input.timezone),
			active: input.active
		})
		.returning();
	return row!;
}

export async function updateReminder(
	ctx: Ctx,
	id: string,
	input: Partial<z.infer<typeof reminderInput>>
) {
	const [prev] = await db
		.select()
		.from(reminder)
		.where(and(eq(reminder.id, id), eq(reminder.userId, ctx.userId)));
	if (!prev) error(404, 'Reminder not found');
	const startsAt = input.startsAt ? new Date(input.startsAt) : prev.startsAt;
	const tz = input.timezone ?? prev.timezone;
	const [row] = await db
		.update(reminder)
		.set({
			...(input.title !== undefined && { title: input.title }),
			...(input.notes !== undefined && { notes: input.notes ?? null }),
			...(input.active !== undefined && { active: input.active }),
			startsAt,
			timezone: tz,
			...(input.repeat !== undefined && { rrule: presetRule(input.repeat, startsAt, tz) })
		})
		.where(eq(reminder.id, id))
		.returning();
	return row!;
}

export async function deleteReminder(ctx: Ctx, id: string) {
	await db.delete(reminder).where(and(eq(reminder.id, id), eq(reminder.userId, ctx.userId)));
}

export async function reminderOccurrences(
	ctx: Ctx,
	from: Date,
	to: Date
): Promise<ReminderOccurrenceDTO[]> {
	const rows = await db
		.select()
		.from(reminder)
		.where(
			and(
				eq(reminder.userId, ctx.userId),
				eq(reminder.workspaceId, ctx.workspaceId),
				eq(reminder.active, true),
				lt(reminder.startsAt, to)
			)
		);
	return rows
		.flatMap((r) =>
			expand({ ...r, endsAt: r.startsAt }, from, to).map((o) => ({
				reminderId: r.id,
				title: r.title,
				at: o.start.toISOString(),
				recurring: !!r.rrule
			}))
		)
		.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------- cycles ----------

export const cycleInput = z.object({
	name: z.string().trim().min(1).max(120),
	kind: z.enum(['medication', 'supplement', 'training', 'other']).default('medication'),
	doseLabel: z.string().max(120).nullish(),
	startDate: z.iso.date(),
	onDays: z.number().int().min(1).max(3650),
	offDays: z.number().int().min(0).max(3650),
	repeatCount: z.number().int().min(1).max(1000).nullish(),
	doseTimes: z
		.array(z.string().regex(/^\d{2}:\d{2}$/))
		.max(12)
		.default([]),
	timezone: z.string().default('UTC'),
	color: z
		.string()
		.regex(/^#[0-9a-fA-F]{6}$/)
		.default('#8E4EC6'),
	notes: z.string().max(5000).nullish()
});

export async function listCycles(ctx: Ctx) {
	return db
		.select()
		.from(cycle)
		.where(and(eq(cycle.userId, ctx.userId), eq(cycle.workspaceId, ctx.workspaceId)))
		.orderBy(asc(cycle.pausedAt), asc(cycle.name));
}

export async function getCycle(ctx: Ctx, id: string) {
	const [row] = await db
		.select()
		.from(cycle)
		.where(and(eq(cycle.id, id), eq(cycle.userId, ctx.userId)));
	if (!row) error(404, 'Cycle not found');
	return row;
}

export async function createCycle(ctx: Ctx, input: z.infer<typeof cycleInput>) {
	const [row] = await db
		.insert(cycle)
		.values({
			...input,
			repeatCount: input.repeatCount ?? null,
			doseLabel: input.doseLabel ?? null,
			notes: input.notes ?? null,
			workspaceId: ctx.workspaceId,
			userId: ctx.userId
		})
		.returning();
	return row!;
}

export async function updateCycle(
	ctx: Ctx,
	id: string,
	input: Partial<z.infer<typeof cycleInput>> & { paused?: boolean }
) {
	const prev = await getCycle(ctx, id);
	const { paused, ...rest } = input;
	const [row] = await db
		.update(cycle)
		.set({
			...rest,
			...(paused !== undefined && { pausedAt: paused ? (prev.pausedAt ?? new Date()) : null })
		})
		.where(eq(cycle.id, id))
		.returning();
	return row!;
}

export async function deleteCycle(ctx: Ctx, id: string) {
	await getCycle(ctx, id);
	await db.delete(cycle).where(eq(cycle.id, id));
}

const toDef = (c: typeof cycle.$inferSelect) => ({
	...c,
	doseTimes: c.doseTimes.map((t) => t.slice(0, 5))
});

export async function cycleBands(
	ctx: Ctx,
	fromDate: string,
	toDate: string
): Promise<CycleBandDTO[]> {
	const rows = await listCycles(ctx);
	return rows.flatMap((c) =>
		phaseSegments(toDef(c), fromDate, toDate).map((s) => ({
			cycleId: c.id,
			name: c.name,
			color: c.color,
			...s
		}))
	);
}

export async function doses(ctx: Ctx, from: Date, to: Date): Promise<DoseDTO[]> {
	const rows = await listCycles(ctx);
	if (!rows.length) return [];
	const logs = await db
		.select()
		.from(doseLog)
		.where(
			and(
				inArray(
					doseLog.cycleId,
					rows.map((r) => r.id)
				),
				gte(doseLog.scheduledFor, from),
				lt(doseLog.scheduledFor, to)
			)
		);
	const logged = new Map(
		logs.map((l) => [`${l.cycleId}:${l.scheduledFor.toISOString()}`, l.status])
	);
	return rows
		.flatMap((c) =>
			doseOccurrences(toDef(c), from, to).map((at) => ({
				cycleId: c.id,
				name: c.name,
				doseLabel: c.doseLabel,
				color: c.color,
				at: at.toISOString(),
				status: (logged.get(`${c.id}:${at.toISOString()}`) ?? null) as DoseDTO['status']
			}))
		)
		.sort((a, b) => a.at.localeCompare(b.at));
}

export const doseInput = z.object({
	cycleId: z.uuid(),
	at: z.iso.datetime({ offset: true }),
	status: z.enum(['taken', 'skipped']).nullable()
});

export async function logDose(ctx: Ctx, input: z.infer<typeof doseInput>) {
	await getCycle(ctx, input.cycleId);
	const at = new Date(input.at);
	if (input.status === null) {
		await db
			.delete(doseLog)
			.where(and(eq(doseLog.cycleId, input.cycleId), eq(doseLog.scheduledFor, at)));
		return;
	}
	await db
		.insert(doseLog)
		.values({ cycleId: input.cycleId, scheduledFor: at, status: input.status })
		.onConflictDoUpdate({
			target: [doseLog.cycleId, doseLog.scheduledFor],
			set: { status: input.status, loggedAt: new Date() }
		});
}

export async function adherence(ctx: Ctx, cycleId: string, days = 30) {
	const c = await getCycle(ctx, cycleId);
	const to = new Date();
	const from = new Date(to.getTime() - days * 86_400_000);
	const scheduled = doseOccurrences(toDef(c), from, to);
	const logs = await db
		.select()
		.from(doseLog)
		.where(and(eq(doseLog.cycleId, cycleId), gte(doseLog.scheduledFor, from)))
		.orderBy(desc(doseLog.scheduledFor));
	const taken = logs.filter((l) => l.status === 'taken').length;
	return {
		scheduled: scheduled.length,
		taken,
		rate: scheduled.length ? taken / scheduled.length : null,
		logs
	};
}
