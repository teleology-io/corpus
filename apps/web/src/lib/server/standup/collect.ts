// Read-only evidence collection. Queries the DB, Workbench state and git history; never writes.
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import type { Coverage, StandupSnapshot } from '#lib/standup/model.js';
import type { Ctx } from '../ctx.js';
import { listOccurrences } from '../calendar.js';
import { listTasks } from '../planner.js';
import { workbenchAllowed } from '../wrx/access.js';
import { workbenchActivity } from '../wrx/index.js';
import { buildItems, type IntegrationRow, type RawEvidence, type ReviewRow } from './build.js';
import { SNAPSHOT_TTL_MS } from './sign.js';
import { standupWindow } from './window.js';

const { integrationConnection: conn, integrationItem: item, prReview } = schema;
const FEED_PROVIDERS = ['github', 'linear'] as const;
const LABEL: Record<string, string> = { github: 'GitHub', linear: 'Linear' };

export async function collectStandup(ctx: Ctx, now = new Date()): Promise<StandupSnapshot> {
	const w = standupWindow(ctx.tz, now);
	const window = { label: w.label, from: w.from, to: w.to, todayEnd: w.todayEnd, today: w.today };
	const hasWorkbench = workbenchAllowed(ctx.user.email);

	const [tasksDone, tasksOpen, events, connections, items, reviews, workbench] = await Promise.all([
		listTasks(ctx, { from: w.from, to: w.to, completed: true }),
		listTasks(ctx, {
			from: w.to,
			to: w.todayEnd,
			includeOverdue: true,
			includeUndated: true,
			completed: false
		}),
		listOccurrences(ctx, w.to, w.todayEnd),
		db
			.select({ provider: conn.provider, status: conn.status })
			.from(conn)
			.where(and(eq(conn.userId, ctx.userId), inArray(conn.provider, [...FEED_PROVIDERS]))),
		db
			.select({
				id: item.id,
				provider: conn.provider,
				kind: item.kind,
				title: item.title,
				subtitle: item.subtitle,
				url: item.url,
				state: item.state,
				payload: item.payload,
				resolvedAt: item.resolvedAt,
				accountLogin: conn.accountLogin
			})
			.from(item)
			.innerJoin(conn, eq(item.connectionId, conn.id))
			.where(
				and(
					eq(conn.userId, ctx.userId),
					inArray(conn.provider, [...FEED_PROVIDERS]),
					// Open now, or resolved since the window began (merged/closed in the window).
					or(isNull(item.resolvedAt), gte(item.resolvedAt, w.from))
				)
			)
			.limit(500),
		db
			.select({
				id: prReview.id,
				itemId: prReview.itemId,
				title: item.title,
				subtitle: item.subtitle,
				url: item.url,
				status: prReview.status,
				postedUrl: prReview.postedUrl,
				postedBy: prReview.postedBy,
				accountLogin: conn.accountLogin,
				findings: prReview.findings,
				updatedAt: prReview.updatedAt
			})
			.from(prReview)
			.innerJoin(item, eq(prReview.itemId, item.id))
			.innerJoin(conn, eq(item.connectionId, conn.id))
			.where(and(eq(prReview.userId, ctx.userId), gte(prReview.updatedAt, w.from)))
			.limit(200),
		hasWorkbench ? workbenchActivity(ctx.userId, w.from, w.to) : Promise.resolve(null)
	]);

	const coverage: Coverage[] = [
		{ source: 'tasks', label: 'Tasks', status: 'included' },
		{ source: 'calendar', label: 'Calendar', status: 'included' },
		hasWorkbench
			? { source: 'workbench', label: 'Workbench', status: 'included' }
			: {
					source: 'workbench',
					label: 'Workbench',
					status: 'unavailable',
					note: 'No Workbench access'
				},
		...FEED_PROVIDERS.map((p): Coverage => {
			const c = connections.filter((x) => x.provider === p);
			if (!c.length) return { source: p, label: LABEL[p]!, status: 'not_connected' };
			if (c.some((x) => x.status === 'active'))
				return { source: p, label: LABEL[p]!, status: 'included' };
			return {
				source: p,
				label: LABEL[p]!,
				status: 'unavailable',
				note: 'Connection needs attention'
			};
		})
	];

	const raw: RawEvidence = {
		tz: ctx.tz,
		window,
		tasksDone,
		tasksOpen,
		events,
		workbench,
		items: items.map((r): IntegrationRow => ({
			...r,
			resolvedAt: r.resolvedAt?.toISOString() ?? null
		})),
		reviews: reviews.map((r): ReviewRow => ({
			...r,
			findings: Array.isArray(r.findings) ? r.findings.length : 0,
			updatedAt: r.updatedAt.toISOString()
		})),
		coverage
	};
	const built = buildItems(raw);
	return {
		v: 1,
		id: randomUUID(),
		userId: ctx.userId,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString(),
		timezone: ctx.tz,
		window: { label: w.label, from: w.from.toISOString(), to: w.to.toISOString() },
		items: built.items,
		coverage: built.coverage
	};
}
