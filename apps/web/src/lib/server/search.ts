import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema } from '@corpus/db';
import { localDate } from '@corpus/core';
import type { SearchResponse } from '#lib/types.js';
import { runSearchProviders, type SearchProvider } from './search-provider.js';
import type { Ctx } from './ctx.js';
import { matcher, sqlMatcher, sqlRank, termsOf } from './search-matching.js';
import { searchDb } from './search-db.js';
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
	slackMessage: message,
	slackConversation: conversation,
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
const providers: SearchProvider[] = [
	{
		id: 'pages',
		search: ({ query }) =>
			PAGES.filter(([label]) => matcher(query)(label)).map(([label, href]) => ({
				kind: 'Page',
				title: label,
				detail: 'Go to page',
				href
			}))
	},
	{
		id: 'notes',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const notes = await searchNotes(ctx, q, limit, db);
			return notes.slice(0, limit).map((n) => ({
				kind: 'Note',
				title: `${n.icon ?? '📄'} ${n.title || 'Untitled'}`,
				detail: n.snippet ?? '',
				href: `/notes/${n.id}`
			}));
		}
	},
	{
		id: 'tasks',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const where = sqlMatcher(q);
			const day = (d: Date) => localDate(d, ctx.tz);
			const tasks = await db
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
						where(task.title, task.notes)
					)
				)
				.orderBy(sqlRank(q, task.title), task.completedAt, desc(task.createdAt))
				.limit(limit);
			return tasks.map((t) => ({
				kind: 'Task',
				title: t.title,
				detail: t.completedAt ? 'Done' : t.dueAt ? `Due ${day(t.dueAt)}` : 'No due date',
				href: `/tasks/${t.id}`
			}));
		}
	},
	{
		id: 'events',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const where = sqlMatcher(q);
			const day = (d: Date) => localDate(d, ctx.tz);
			const attending = db
				.select({ id: eventAttendee.eventId })
				.from(eventAttendee)
				.where(eq(eventAttendee.userId, ctx.userId));
			const events = await db
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
						where(event.title, event.description, event.location)
					)
				)
				.orderBy(sqlRank(q, event.title), desc(event.startsAt))
				.limit(limit);
			return events.map((e) => ({
				kind: 'Event',
				title: e.title,
				detail: [day(e.startsAt), e.location].filter(Boolean).join(' · '),
				href: `/calendar?date=${day(e.startsAt)}&event=${e.id}`
			}));
		}
	},
	{
		id: 'cycles',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const where = sqlMatcher(q);
			const cycles = await db
				.select({ id: cycle.id, name: cycle.name, pausedAt: cycle.pausedAt })
				.from(cycle)
				.where(
					and(
						eq(cycle.userId, ctx.userId),
						eq(cycle.workspaceId, ctx.workspaceId),
						where(cycle.name)
					)
				)
				.orderBy(sqlRank(q, cycle.name), asc(cycle.pausedAt), asc(cycle.name))
				.limit(limit);
			return cycles.map((c) => ({
				kind: 'Cycle',
				title: c.name,
				detail: c.pausedAt ? 'Paused' : 'Active',
				href: `/cycles/${c.id}`
			}));
		}
	},
	{
		id: 'reminders',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const where = sqlMatcher(q);
			const reminders = await db
				.select({ id: reminder.id, title: reminder.title, active: reminder.active })
				.from(reminder)
				.where(
					and(
						eq(reminder.userId, ctx.userId),
						eq(reminder.workspaceId, ctx.workspaceId),
						where(reminder.title)
					)
				)
				.orderBy(sqlRank(q, reminder.title), desc(reminder.active), asc(reminder.startsAt))
				.limit(limit);
			return reminders.map((r) => ({
				kind: 'Reminder',
				title: r.title,
				detail: r.active ? 'Active' : 'Off',
				href: `/cycles?reminder=${r.id}`
			}));
		}
	},
	{
		id: 'videos',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const where = sqlMatcher(q);
			const day = (d: Date) => localDate(d, ctx.tz);
			const videos = await db
				.select({ id: video.id, title: video.title, createdAt: video.createdAt })
				.from(video)
				.where(
					and(
						eq(video.ownerId, ctx.userId),
						eq(video.workspaceId, ctx.workspaceId),
						eq(video.status, 'ready'),
						where(
							video.title,
							sql`(select string_agg(segment->>'text', ' ') from jsonb_array_elements(coalesce(${video.transcript}, '[]'::jsonb)) segment)`
						)
					)
				)
				.orderBy(sqlRank(q, video.title), desc(video.createdAt))
				.limit(limit);
			return videos.map((v) => ({
				kind: 'Recording',
				title: v.title || 'Untitled recording',
				detail: day(new Date(v.createdAt)),
				href: `/telescope/${v.id}`
			}));
		}
	},
	{
		id: 'items',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const where = sqlMatcher(q);
			const items = await db
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
				.orderBy(sqlRank(q, item.title), desc(item.externalUpdatedAt))
				.limit(limit);
			return items.map((i) => ({
				kind:
					i.provider === 'linear' ? 'Linear' : i.provider === 'github' ? 'GitHub' : 'Integration',
				title: i.title,
				detail: [i.subtitle, i.state].filter(Boolean).join(' · '),
				href: i.url,
				external: true
			}));
		}
	},
	{
		id: 'threads',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const where = sqlMatcher(q);
			const threads = await db
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
				.orderBy(sqlRank(q, thread.preview), sql`${thread.lastActivityAt} desc nulls first`)
				.limit(limit);
			return threads.map((t) => ({
				kind: 'Slack',
				title: t.preview ?? 'Thread',
				detail: [t.channelName, t.authorName].filter(Boolean).join(' · '),
				href: `/integrations/slack?thread=${t.id}`
			}));
		}
	},
	{
		id: 'slack-messages',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const rows = await db
				.select({
					text: message.text,
					ts: message.ts,
					threadTs: message.threadTs,
					channel: message.channelId,
					name: conversation.name
				})
				.from(message)
				.innerJoin(conn, eq(message.connectionId, conn.id))
				.innerJoin(
					conversation,
					and(
						eq(conversation.connectionId, message.connectionId),
						eq(conversation.channelId, message.channelId)
					)
				)
				.where(
					and(
						eq(conn.userId, ctx.userId),
						eq(conn.provider, 'slack'),
						isNull(message.deletedAt),
						isNull(conversation.inaccessibleAt),
						eq(conversation.isMember, true),
						sqlMatcher(q)(message.text, conversation.name)
					)
				)
				.orderBy(sqlRank(q, message.text), desc(message.tsNum))
				.limit(limit);
			return rows.map((m) => ({
				kind: 'Slack',
				title: m.text.slice(0, 180) || 'Message',
				detail: m.name ?? 'Slack conversation',
				href: `/integrations/slack?${new URLSearchParams({ c: m.channel, ts: m.ts, ...(m.threadTs ? { t: m.threadTs } : {}) })}`
			}));
		}
	},

	{
		id: 'members',
		async search({ ctx, query: q, limit, signal }) {
			const db = searchDb(signal);
			const where = sqlMatcher(q);
			const members = await db
				.select({ name: user.name, email: user.email })
				.from(member)
				.innerJoin(user, eq(member.userId, user.id))
				.where(and(eq(member.organizationId, ctx.workspaceId), where(user.name, user.email)))
				.orderBy(sqlRank(q, user.name), member.createdAt)
				.limit(limit);
			return members.map((m) => ({
				kind: 'Person',
				title: m.name,
				detail: m.email,
				href: '/teams'
			}));
		}
	},
	{
		id: 'workbench',
		search: ({ ctx, query: q }) =>
			workbenchAllowed(ctx.user.email) ? workbenchSearch(ctx.userId, q) : []
	}
];
/** Register new sources above; the HTTP API and palette only depend on SearchResult. */
export async function searchAll(
	ctx: Ctx,
	q: string,
	signal?: AbortSignal
): Promise<SearchResponse> {
	const query = q.trim().slice(0, 200);
	const failedSources: string[] = [];
	const results = await runSearchProviders(providers, {
		ctx,
		query,
		terms: termsOf(query),
		limit: PER_KIND,
		signal,
		onFailure: (id) => failedSources.push(id)
	});
	return { results, failedSources: failedSources.sort() };
}
