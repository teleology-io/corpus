import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import {
	parseSetting,
	readSetting,
	type SettingKey,
	type SettingValue,
	type SettingValues
} from '#lib/settings.js';

const { userSettings } = schema;

/** The given settings for a user, merged with registry defaults. One query. */
export async function getSettings<K extends SettingKey>(
	userId: string,
	keys: readonly K[]
): Promise<SettingValues<K>> {
	const rows = keys.length
		? await db
				.select({ key: userSettings.key, value: userSettings.value })
				.from(userSettings)
				.where(and(eq(userSettings.userId, userId), inArray(userSettings.key, [...keys])))
		: [];
	const stored = new Map(rows.map((r) => [r.key, r.value]));
	return Object.fromEntries(
		keys.map((k) => [k, readSetting(k, stored.get(k))])
	) as SettingValues<K>;
}

/** Validates against the registry (throws on unknown key / bad value), then upserts. */
export async function setSetting(userId: string, key: string, value: unknown) {
	const parsed = parseSetting(key, value);
	await db
		.insert(userSettings)
		.values({ userId, key: parsed.key, value: parsed.value })
		.onConflictDoUpdate({
			target: [userSettings.userId, userSettings.key],
			set: { value: parsed.value, updatedAt: new Date() }
		});
	return parsed as { key: SettingKey; value: SettingValue<SettingKey> };
}
