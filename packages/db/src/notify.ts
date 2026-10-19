import { and, eq, inArray } from 'drizzle-orm';
import { type NotificationInput, resolvePrefs } from '@corpus/core';
import { db, publish, sql } from './index';
import { notification, notificationDelivery, notificationPref } from './schema/index';

export const DELIVERY_CHANNEL = 'corpus_delivery';

/**
 * Create notifications idempotently (per user + dedupeKey), queue push/email deliveries per
 * user prefs, and publish realtime events. Returns the rows actually inserted.
 */
export async function notify(inputs: NotificationInput | NotificationInput[]) {
	const list = Array.isArray(inputs) ? inputs : [inputs];
	if (!list.length) return [];

	const userIds = [...new Set(list.map((n) => n.userId))];
	const prefs = await db
		.select()
		.from(notificationPref)
		.where(inArray(notificationPref.userId, userIds));
	const prefFor = (userId: string, type: string) =>
		prefs.find((p) => p.userId === userId && p.type === type);

	const inserted = await db
		.insert(notification)
		.values(
			list.map((n) => ({
				userId: n.userId,
				workspaceId: n.workspaceId ?? null,
				type: n.type,
				title: n.title,
				body: n.body ?? null,
				href: n.href ?? null,
				sourceType: n.sourceType ?? null,
				sourceId: n.sourceId ?? null,
				dedupeKey: n.dedupeKey,
				data: n.data ?? null,
				// Muted in-app: still stored (for history) but born read so it never badges.
				readAt: resolvePrefs(n.type, prefFor(n.userId, n.type)).inApp ? null : new Date()
			}))
		)
		.onConflictDoNothing()
		.returning();

	const deliveries = inserted.flatMap((row) => {
		const p = resolvePrefs(row.type as NotificationInput['type'], prefFor(row.userId, row.type));
		const out: (typeof notificationDelivery.$inferInsert)[] = [];
		if (p.push) out.push({ notificationId: row.id, channel: 'push' });
		if (p.email) out.push({ notificationId: row.id, channel: 'email' });
		return out;
	});
	if (deliveries.length) {
		await db.insert(notificationDelivery).values(deliveries).onConflictDoNothing();
		await sql.notify(DELIVERY_CHANNEL, 'new');
	}

	await Promise.all(
		inserted
			.filter((row) => !row.readAt)
			.map((row) =>
				publish(row.userId, {
					type: 'notification',
					notification: {
						id: row.id,
						type: row.type,
						title: row.title,
						body: row.body,
						href: row.href,
						createdAt: row.createdAt
					}
				})
			)
	);
	return inserted;
}

export async function markRead(userId: string, ids?: string[]) {
	const where = ids?.length
		? and(eq(notification.userId, userId), inArray(notification.id, ids))
		: eq(notification.userId, userId);
	await db.update(notification).set({ readAt: new Date() }).where(where);
	await publish(userId, { type: 'notifications_read', ids: ids ?? null });
}
