import {
	and,
	asc,
	desc,
	eq,
	ilike,
	inArray,
	isNull,
	or,
	sql,
	type AnyColumn,
	type SQL
} from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { localDate } from '@corpus/core';
import type { SearchResult } from '#lib/types.js';
import type { Ctx } from './ctx.js';
import { searchNotes } from './notes.js';
import { workbenchAllowed } from './wrx/access.js';
import { workbenchSearch } from './wrx/index.js';

const {
	task,
	event,
	eventAttendee,
	cycle,
	reminder,
	telescopeVideo: video,
	integrationItem: item,
	integrationConnection: conn,
	slackThread: thread,
	member,
	user
} = schema;

const PAGES = [
	['Dashboard', '/dashboard'],
	['My Calendar', '/calendar'],
	['Cycles & reminders', '/cycles'],
	['My Notes', '/notes'],
	['Workbench', '/workbench'],
	['Telescope', '/telescope'],
	['Record a video', '/telescope/record'],
	['Teams', '/teams'],
	['Integrations', '/integrations'],
	['Slack threads', '/integrations/slack'],
	['Settings', '/settings'],
	['Security', '/security'],
	['Help', '/help']
] as const;

const PER_KIND = 8;
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const termsOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
/** Every whitespace-separated term appears somewhere in the haystack. */
const matcher = (q: string) => {
	const terms = termsOf(q);
	return (...fields: (string | null | undefined)[]) => {
		const text = fields.filter(Boolean).join(' ').toLowerCase();
		return terms.every((t) => text.includes(t));
	};
};
/**
 * SQL twin of `matcher`: each term must appear in the fields joined with spaces (concat_ws
 * skips nulls, like the JS filter), so filtering and limiting happen in the database instead
 * of loading every row per keystroke.
 */
const sqlMatcher = (q: string) => {
	const terms = termsOf(q);
	return (...fields: AnyColumn[]): SQL | undefined => {
		const haystack = sql`concat_ws(' ', ${sql.join(fields, sql`, `)})`;
		return terms.length ? and(...terms.map((t) => sql`${haystack} ilike ${like(t)}`)) : undefined;
	};
};

/** App-wide search: pages, notes, tasks, events, planner, recordings, integrations, people, Workbench. */
export async function searchAll(ctx: Ctx, q: string): Promise<SearchResult[]> {
	const hit = matcher(q);
	const where = sqlMatcher(q);
	const pattern = like(q);
	// One failing source (e.g. a provider table) shouldn't sink the whole palette.
	const safe = <T>(p: Promise<T[]>) => p.catch(() => [] as T[]);
	const attending = db
		.select({ id: eventAttendee.eventId })
		.from(eventAttendee)
		.where(eq(eventAttendee.userId, ctx.userId));

	const [notes, tasks, events, cycles, reminders, videos, items, threads, members] =
		await Promise.all([
			safe(searchNotes(ctx, q)),
			safe(
				db
					.select({
						id: task.id,
						title: task.title,
						dueAt: task.dueAt,
						completedAt: task.completedAt
					})
					.from(task)
					.where(
						and(
							eq(task.workspaceId, ctx.workspaceId),
							or(isNull(task.assigneeId), eq(task.assigneeId, ctx.userId)),
							or(ilike(task.title, pattern), ilike(task.notes, pattern))
						)
					)
					.orderBy(task.completedAt, desc(task.createdAt))
					.limit(PER_KIND)
			),
			safe(
				db
					.select({
						id: event.id,
						title: event.title,
						location: event.location,
						startsAt: event.startsAt
					})
					.from(event)
					.where(
						and(
							isNull(event.deletedAt),
							or(eq(event.workspaceId, ctx.workspaceId), inArray(event.id, attending)),
							or(
								ilike(event.title, pattern),
								ilike(event.description, pattern),
								ilike(event.location, pattern)
							)
						)
					)
					.orderBy(desc(event.startsAt))
					.limit(PER_KIND)
			),
			safe(
				db
					.select({ id: cycle.id, name: cycle.name, pausedAt: cycle.pausedAt })
					.from(cycle)
					.where(
						and(
							eq(cycle.userId, ctx.userId),
							eq(cycle.workspaceId, ctx.workspaceId),
							where(cycle.name)
						)
					)
					.orderBy(asc(cycle.pausedAt), asc(cycle.name))
					.limit(PER_KIND)
			),
			safe(
				db
					.select({ title: reminder.title, active: reminder.active })
					.from(reminder)
					.where(
						and(
							eq(reminder.userId, ctx.userId),
							eq(reminder.workspaceId, ctx.workspaceId),
							where(reminder.title)
						)
					)
					.orderBy(desc(reminder.active), asc(reminder.startsAt))
					.limit(PER_KIND)
			),
			safe(
				db
					.select({ id: video.id, title: video.title, createdAt: video.createdAt })
					.from(video)
					.where(
						and(
							eq(video.ownerId, ctx.userId),
							eq(video.workspaceId, ctx.workspaceId),
							eq(video.status, 'ready'),
							where(video.title)
						)
					)
					.orderBy(desc(video.createdAt))
					.limit(PER_KIND)
			),
			safe(
				db
					.select({
						provider: conn.provider,
						title: item.title,
						subtitle: item.subtitle,
						url: item.url,
						state: item.state
					})
					.from(item)
					.innerJoin(conn, eq(item.connectionId, conn.id))
					.where(
						and(
							eq(conn.userId, ctx.userId),
							isNull(item.resolvedAt),
							where(item.title, item.subtitle, conn.provider)
						)
					)
					.orderBy(desc(item.externalUpdatedAt))
					.limit(PER_KIND)
			),
			safe(
				db
					.select({
						id: thread.id,
						preview: thread.preview,
						channelName: thread.channelName,
						authorName: thread.authorName
					})
					.from(thread)
					.innerJoin(conn, eq(thread.connectionId, conn.id))
					.where(
						and(
							eq(conn.userId, ctx.userId),
							eq(conn.provider, 'slack'),
							eq(thread.followed, true),
							where(thread.preview, thread.channelName, thread.authorName)
						)
					)
					.orderBy(sql`${thread.lastActivityAt} desc nulls first`)
					.limit(PER_KIND)
			),
			safe(
				db
					.select({ name: user.name, email: user.email })
					.from(member)
					.innerJoin(user, eq(member.userId, user.id))
					.where(and(eq(member.organizationId, ctx.workspaceId), where(user.name, user.email)))
					.orderBy(member.createdAt)
					.limit(PER_KIND)
			)
		]);

	const day = (d: Date) => localDate(d, ctx.tz);
	const results: SearchResult[] = [
		...PAGES.filter(([label]) => hit(label)).map(([label, href]) => ({
			kind: 'Page',
			title: label,
			detail: 'Go to page',
			href
		})),
		...notes.slice(0, PER_KIND).map((n) => ({
			kind: 'Note',
			title: `${n.icon ?? '📄'} ${n.title || 'Untitled'}`,
			detail: n.snippet ?? '',
			href: `/notes/${n.id}`
		})),
		...tasks.map((t) => ({
			kind: 'Task',
			title: t.title,
			detail: t.completedAt ? 'Done' : t.dueAt ? `Due ${day(t.dueAt)}` : 'No due date',
			href: '/dashboard'
		})),
		...events.map((e) => ({
			kind: 'Event',
			title: e.title,
			detail: [day(e.startsAt), e.location].filter(Boolean).join(' · '),
			href: `/calendar?date=${day(e.startsAt)}&event=${e.id}`
		})),
		...cycles.map((c) => ({
			kind: 'Cycle',
			title: c.name,
			detail: c.pausedAt ? 'Paused' : 'Active',
			href: `/cycles/${c.id}`
		})),
		...reminders.map((r) => ({
			kind: 'Reminder',
			title: r.title,
			detail: r.active ? 'Active' : 'Off',
			href: '/cycles'
		})),
		...videos.map((v) => ({
			kind: 'Recording',
			title: v.title || 'Untitled recording',
			detail: day(new Date(v.createdAt)),
			href: `/telescope/${v.id}`
		})),
		...items.map((i) => ({
			kind: i.provider === 'linear' ? 'Linear' : i.provider === 'github' ? 'GitHub' : 'Integration',
			title: i.title,
			detail: [i.subtitle, i.state].filter(Boolean).join(' · '),
			href: i.url,
			external: true
		})),
		...threads.map((t) => ({
			kind: 'Slack',
			title: t.preview ?? 'Thread',
			detail: [t.channelName, t.authorName].filter(Boolean).join(' · '),
			href: `/integrations/slack?thread=${t.id}`
		})),
		...members.map((m) => ({ kind: 'Person', title: m.name, detail: m.email, href: '/teams' })),
		...(workbenchAllowed(ctx.user.email) ? workbenchSearch(ctx.userId, q) : [])
	];
	return results;
}
