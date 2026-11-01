import { and, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { localDate } from '@corpus/core';
import type { SearchResult } from '#lib/types.js';
import type { Ctx } from './ctx.js';
import { searchNotes } from './notes.js';
import { listCycles, listReminders } from './planner.js';
import { listVideos } from './telescope.js';
import { openItems } from './integrations.js';
import { listThreads } from './slack.js';
import { workspaceMembers } from './workspaces.js';
import { workbenchAllowed } from './wrx/access.js';
import { workbenchSearch } from './wrx/index.js';

const { task, event, eventAttendee } = schema;

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
/** Every whitespace-separated term appears somewhere in the haystack. */
const matcher = (q: string) => {
	const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
	return (...fields: (string | null | undefined)[]) => {
		const text = fields.filter(Boolean).join(' ').toLowerCase();
		return terms.every((t) => text.includes(t));
	};
};

/** App-wide search: pages, notes, tasks, events, planner, recordings, integrations, people, Workbench. */
export async function searchAll(ctx: Ctx, q: string): Promise<SearchResult[]> {
	const hit = matcher(q);
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
			safe(listCycles(ctx)),
			safe(listReminders(ctx)),
			safe(listVideos(ctx)),
			safe(openItems(ctx.userId, { limit: 500 })),
			safe(listThreads(ctx.userId, 200)),
			safe(workspaceMembers(ctx.workspaceId))
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
		...cycles
			.filter((c) => hit(c.name))
			.slice(0, PER_KIND)
			.map((c) => ({
				kind: 'Cycle',
				title: c.name,
				detail: c.pausedAt ? 'Paused' : 'Active',
				href: `/cycles/${c.id}`
			})),
		...reminders
			.filter((r) => hit(r.title))
			.slice(0, PER_KIND)
			.map((r) => ({
				kind: 'Reminder',
				title: r.title,
				detail: r.active ? 'Active' : 'Off',
				href: '/cycles'
			})),
		...videos
			.filter((v) => hit(v.title))
			.slice(0, PER_KIND)
			.map((v) => ({
				kind: 'Recording',
				title: v.title || 'Untitled recording',
				detail: day(new Date(v.createdAt)),
				href: `/telescope/${v.id}`
			})),
		...items
			.filter((i) => hit(i.title, i.subtitle, i.provider))
			.slice(0, PER_KIND)
			.map((i) => ({
				kind:
					i.provider === 'linear' ? 'Linear' : i.provider === 'github' ? 'GitHub' : 'Integration',
				title: i.title,
				detail: [i.subtitle, i.state].filter(Boolean).join(' · '),
				href: i.url,
				external: true
			})),
		...threads
			.filter((t) => hit(t.preview, t.channelName, t.authorName))
			.slice(0, PER_KIND)
			.map((t) => ({
				kind: 'Slack',
				title: t.preview ?? 'Thread',
				detail: [t.channelName, t.authorName].filter(Boolean).join(' · '),
				href: `/integrations/slack?thread=${t.id}`
			})),
		...members
			.filter((m) => hit(m.name, m.email))
			.slice(0, PER_KIND)
			.map((m) => ({ kind: 'Person', title: m.name, detail: m.email, href: '/teams' })),
		...(workbenchAllowed(ctx.user.email) ? workbenchSearch(ctx.userId, q) : [])
	];
	return results;
}
