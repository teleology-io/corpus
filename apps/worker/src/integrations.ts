import { and, eq, inArray, isNull, sql as dsql } from 'drizzle-orm';
import { db, publish, schema, sql } from '@corpus/db';
import { accessToken } from '@corpus/db/connections';
import { notify } from '@corpus/db/notify';
import {
	ProviderAuthError,
	SlackApiError,
	diffItems,
	getProvider,
	itemHash,
	type ExternalItem,
	type Provider
} from '@corpus/core/integrations';
import type { NotificationInput } from '@corpus/core';
import { syncGoogle } from './google-sync';
import { syncSlack } from './slack-sync';

const { integrationConnection: conn, integrationItem: item, task } = schema;
export type Conn = typeof conn.$inferSelect;

/** What one poll produced; persisted onto the connection by pollConnection. */
export interface SyncResult {
	cursor: Record<string, string>;
	intervalSec: number;
	changes: number;
}

/** Integrations are per user; synced tasks and calendars land in the personal workspace. */
export async function personalWorkspace(userId: string) {
	const [row] = await db
		.select({ id: schema.organization.id })
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.where(and(eq(schema.member.userId, userId), eq(schema.organization.kind, 'personal')))
		.limit(1);
	return row?.id ?? null;
}

const NOTIFY_TYPE: Partial<Record<ExternalItem['kind'], NotificationInput['type']>> = {
	review_request: 'integration_review_request',
	issue: 'integration_issue_assigned'
};

/** GitHub / Linear: diff the provider's open-item feed, notify, and mirror into tasks. */
async function pollFeed(c: Conn, provider: Provider, token: string): Promise<SyncResult> {
	const firstPoll = !c.lastPolledAt;
	const result = await provider.poll!(token, c.cursor);
	const interval = Math.max(30, result.pollIntervalSec ?? c.pollIntervalSec);

	let changes = 0;
	if (!result.notModified) {
		const existing = await db
			.select({
				id: item.id,
				externalId: item.externalId,
				hash: item.hash,
				resolvedAt: item.resolvedAt
			})
			.from(item)
			.where(eq(item.connectionId, c.id));
		const diff = diffItems(existing, result.items);
		const upserts = [
			...diff.created,
			...diff.changed.map((x) => x.item),
			...diff.reopened.map((x) => x.item)
		];
		changes = upserts.length + diff.resolved.length;

		const saved = upserts.length
			? await db
					.insert(item)
					.values(
						upserts.map((i) => ({
							connectionId: c.id,
							externalId: i.externalId,
							kind: i.kind,
							title: i.title,
							subtitle: i.subtitle ?? null,
							url: i.url,
							state: i.state ?? null,
							hash: itemHash(i),
							externalUpdatedAt: i.externalUpdatedAt ? new Date(i.externalUpdatedAt) : null,
							payload: { ...(i.payload ?? {}), dueDate: i.dueDate ?? null },
							resolvedAt: null
						}))
					)
					.onConflictDoUpdate({
						target: [item.connectionId, item.externalId],
						set: {
							kind: dsql`excluded.kind`,
							title: dsql`excluded.title`,
							subtitle: dsql`excluded.subtitle`,
							url: dsql`excluded.url`,
							state: dsql`excluded.state`,
							hash: dsql`excluded.hash`,
							externalUpdatedAt: dsql`excluded.external_updated_at`,
							payload: dsql`excluded.payload`,
							resolvedAt: null
						}
					})
					.returning({ id: item.id, externalId: item.externalId })
			: [];
		const idByExternal = new Map(saved.map((s) => [s.externalId, s.id]));

		if (diff.resolved.length) {
			await db
				.update(item)
				.set({ resolvedAt: new Date() })
				.where(
					inArray(
						item.id,
						diff.resolved.map((r) => r.id)
					)
				);
		}

		// ----- notifications (skip the initial import to avoid a flood) -----
		if (!firstPoll && c.settings.notify !== false) {
			const notes: NotificationInput[] = [];
			for (const i of [...diff.created, ...diff.reopened.map((x) => x.item)]) {
				const type = NOTIFY_TYPE[i.kind];
				if (!type) continue;
				notes.push({
					userId: c.userId,
					type,
					title:
						i.kind === 'review_request' ? `Review requested: ${i.title}` : `Assigned: ${i.title}`,
					body: `${provider.name} · ${i.subtitle ?? ''}`,
					href: i.url,
					sourceType: `integration:${c.provider}`,
					sourceId: i.externalId,
					dedupeKey: `${type}:${c.id}:${i.externalId}:${i.externalUpdatedAt ?? ''}`
				});
			}
			for (const { item: i } of diff.changed.filter((x) => x.item.kind === 'pull_request')) {
				notes.push({
					userId: c.userId,
					type: 'integration_pr_update',
					title: `${i.title}: ${i.state}`,
					body: i.subtitle ?? null,
					href: i.url,
					sourceType: `integration:${c.provider}`,
					sourceId: i.externalId,
					dedupeKey: `integration_pr_update:${c.id}:${i.externalId}:${i.state}`
				});
			}
			await notify(notes);
		}

		// ----- task sync -----
		if (c.settings.syncTasks !== false) {
			const workspaceId = await personalWorkspace(c.userId);
			const toTask = [...diff.created, ...diff.reopened.map((x) => x.item)].filter(
				(i) => i.kind === 'review_request' || i.kind === 'issue'
			);
			if (workspaceId && toTask.length) {
				const ids = toTask
					.map((i) => idByExternal.get(i.externalId))
					.filter((x): x is string => !!x);
				const already = ids.length
					? await db
							.select({ id: task.integrationItemId })
							.from(task)
							.where(inArray(task.integrationItemId, ids))
					: [];
				const have = new Set(already.map((a) => a.id));
				const rows = toTask
					.map((i) => ({ i, itemId: idByExternal.get(i.externalId) }))
					.filter(
						(x): x is { i: ExternalItem; itemId: string } => !!x.itemId && !have.has(x.itemId)
					);
				if (rows.length) {
					await db.insert(task).values(
						rows.map(({ i, itemId }) => ({
							workspaceId,
							title: i.kind === 'review_request' ? `Review: ${i.title}` : i.title,
							notes: i.subtitle ?? null,
							dueAt: i.dueDate ? new Date(`${i.dueDate}T12:00:00Z`) : null,
							dueAllDay: true,
							source: c.provider,
							externalUrl: i.url,
							integrationItemId: itemId,
							assigneeId: c.userId,
							createdBy: c.userId
						}))
					);
				}
			}
			// Reopened items: un-complete their tasks; resolved items: complete them.
			const reopenedIds = diff.reopened.map((x) => x.previous.id);
			if (reopenedIds.length)
				await db
					.update(task)
					.set({ completedAt: null })
					.where(inArray(task.integrationItemId, reopenedIds));
			if (diff.resolved.length) {
				await db
					.update(task)
					.set({ completedAt: new Date() })
					.where(
						and(
							inArray(
								task.integrationItemId,
								diff.resolved.map((r) => r.id)
							),
							isNull(task.completedAt)
						)
					);
			}
		}
	}

	return { cursor: result.cursor, intervalSec: interval, changes };
}

export async function pollConnection(c: Conn) {
	const provider = getProvider(c.provider);
	if (!provider) return;
	try {
		const token = await accessToken(c);
		const result =
			c.provider === 'google-calendar'
				? await syncGoogle(c, token)
				: c.provider === 'slack'
					? await syncSlack(c, token)
					: await pollFeed(c, provider, token);
		await db
			.update(conn)
			.set({
				cursor: result.cursor,
				status: 'active',
				lastError: null,
				lastPolledAt: new Date(),
				pollIntervalSec: result.intervalSec,
				nextPollAt: new Date(Date.now() + result.intervalSec * 1000)
			})
			.where(eq(conn.id, c.id));
		await publish(c.userId, {
			type: 'integration_items',
			provider: c.provider,
			changes: result.changes
		});
	} catch (e) {
		const auth = e instanceof ProviderAuthError;
		const message = (e as Error).message;
		console.error(`[poll] ${c.provider}/${c.id}: ${message}`);
		await db
			.update(conn)
			.set({
				status: auth ? 'error' : c.status,
				lastError: message.slice(0, 500),
				lastPolledAt: new Date(),
				// Back off: auth errors wait for reconnect; rate limits honor Retry-After;
				// other transient errors retry in 5 min.
				nextPollAt: auth
					? null
					: new Date(
							Date.now() +
								(e instanceof SlackApiError && e.retryAfterSec ? e.retryAfterSec : 300) * 1000
						)
			})
			.where(eq(conn.id, c.id));
		if (auth) {
			await notify({
				userId: c.userId,
				type: 'integration_error',
				title: `${provider.name} needs to be reconnected`,
				body: message,
				href: '/integrations',
				dedupeKey: `integration_error:${c.id}:${new Date().toISOString().slice(0, 10)}`
			});
		}
		await publish(c.userId, { type: 'invalidate', scope: 'integrations' });
	}
}

/** Claim connections that are due and poll them (SKIP LOCKED lets several workers share load). */
export async function pollDue(limit = 10, onlyId?: string) {
	const claimed = await sql.begin(async (tx) => {
		const rows = await tx<{ id: string }[]>`
			select id from integration_connection
			where status = 'active' and next_poll_at is not null and next_poll_at <= now()
				${onlyId ? tx`and id = ${onlyId}` : tx``}
			order by next_poll_at
			limit ${limit}
			for update skip locked`;
		if (rows.length) {
			// Lease for 2 minutes so a crashed poll is retried.
			await tx`update integration_connection set next_poll_at = now() + interval '2 minutes' where id in ${tx(rows.map((r) => r.id))}`;
		}
		return rows.map((r) => r.id);
	});
	if (!claimed.length) return 0;
	const rows = await db.select().from(conn).where(inArray(conn.id, claimed));
	await Promise.allSettled(rows.map(pollConnection));
	return rows.length;
}
