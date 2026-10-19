import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@corpus/db';
import { NOTIFICATION_TYPES, resolvePrefs, type NotificationType } from '@corpus/core';
import type { NotificationDTO } from '#lib/types.js';

const { notification, notificationPref, notificationSettings, pushSubscription } = schema;

export async function listNotifications(userId: string, limit = 30): Promise<NotificationDTO[]> {
	const rows = await db
		.select()
		.from(notification)
		.where(eq(notification.userId, userId))
		.orderBy(desc(notification.createdAt))
		.limit(limit);
	return rows.map((r) => ({
		id: r.id,
		type: r.type,
		title: r.title,
		body: r.body,
		href: r.href,
		readAt: r.readAt?.toISOString() ?? null,
		createdAt: r.createdAt.toISOString()
	}));
}

export async function unreadCount(userId: string) {
	const [row] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(notification)
		.where(and(eq(notification.userId, userId), isNull(notification.readAt)));
	return row?.n ?? 0;
}

export async function getPrefs(userId: string) {
	const [stored, [settings]] = await Promise.all([
		db.select().from(notificationPref).where(eq(notificationPref.userId, userId)),
		db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId))
	]);
	const types = Object.entries(NOTIFICATION_TYPES).map(([type, def]) => {
		const s = stored.find((p) => p.type === type);
		return {
			type,
			label: def.label,
			group: def.group,
			description: def.description,
			...resolvePrefs(
				type as NotificationType,
				s ? { inApp: s.inApp, push: s.push, email: s.email } : null
			)
		};
	});
	return {
		types,
		quietStart: settings?.quietStart ?? null,
		quietEnd: settings?.quietEnd ?? null,
		dailyDigest: settings?.dailyDigest ?? false
	};
}

export const prefsInput = z.object({
	types: z
		.array(
			z.object({ type: z.string(), inApp: z.boolean(), push: z.boolean(), email: z.boolean() })
		)
		.optional(),
	quietStart: z
		.string()
		.regex(/^\d{2}:\d{2}$/)
		.nullish(),
	quietEnd: z
		.string()
		.regex(/^\d{2}:\d{2}$/)
		.nullish(),
	dailyDigest: z.boolean().optional()
});

export async function savePrefs(userId: string, input: z.infer<typeof prefsInput>) {
	for (const t of input.types ?? []) {
		if (!(t.type in NOTIFICATION_TYPES)) continue;
		await db
			.insert(notificationPref)
			.values({ userId, ...t })
			.onConflictDoUpdate({
				target: [notificationPref.userId, notificationPref.type],
				set: { inApp: t.inApp, push: t.push, email: t.email }
			});
	}
	if (
		input.quietStart !== undefined ||
		input.quietEnd !== undefined ||
		input.dailyDigest !== undefined
	) {
		const values = {
			...(input.quietStart !== undefined && { quietStart: input.quietStart ?? null }),
			...(input.quietEnd !== undefined && { quietEnd: input.quietEnd ?? null }),
			...(input.dailyDigest !== undefined && { dailyDigest: input.dailyDigest })
		};
		await db
			.insert(notificationSettings)
			.values({ userId, ...values })
			.onConflictDoUpdate({ target: notificationSettings.userId, set: values });
	}
}

export const pushInput = z.object({
	endpoint: z.url(),
	keys: z.object({ p256dh: z.string(), auth: z.string() })
});

export async function savePushSubscription(
	userId: string,
	input: z.infer<typeof pushInput>,
	userAgent: string | null
) {
	await db
		.insert(pushSubscription)
		.values({ userId, endpoint: input.endpoint, keys: input.keys, userAgent })
		.onConflictDoUpdate({
			target: pushSubscription.endpoint,
			set: { userId, keys: input.keys, userAgent }
		});
}

export async function deletePushSubscription(userId: string, endpoint: string) {
	await db
		.delete(pushSubscription)
		.where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)));
}
