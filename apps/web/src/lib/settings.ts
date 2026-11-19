// Registry of per-user settings. Definitions (type, label, default, allowed values, UI metadata)
// live here; `user_settings` rows only hold a user's overrides. Shared by server and client.
import { z } from 'zod';

interface Base<T> {
	key: string;
	label: string;
	description?: string;
	default: T;
	ui?: { section: string; order?: number };
}
export type SettingDef =
	| (Base<boolean> & { type: 'boolean' })
	| (Base<string> & { type: 'enum'; options: readonly { value: string; label: string }[] })
	| (Base<string> & { type: 'string'; maxLength?: number })
	| (Base<number> & { type: 'number'; min?: number; max?: number });

export const SETTINGS = {
	'standup.enabled': {
		key: 'standup.enabled',
		type: 'boolean',
		label: 'Standup',
		description:
			'Show a Standup button on the dashboard that drafts Yesterday / Today from your activity.',
		default: false,
		ui: { section: 'dashboard', order: 1 }
	},
	'standup.detail': {
		key: 'standup.detail',
		type: 'enum',
		label: 'Standup detail',
		description: 'Compact is terse bullets; Verbose adds outcomes, pending reviews and next steps.',
		options: [
			{ value: 'compact', label: 'Compact' },
			{ value: 'verbose', label: 'Verbose' }
		],
		default: 'compact',
		ui: { section: 'dashboard', order: 2 }
	},
	// Conductor (hidden feature). No `ui`: edited from the Conductor page, not Settings.
	'conductor.repoPath': {
		key: 'conductor.repoPath',
		type: 'string',
		label: 'Repositories',
		description:
			'Git repositories or folders of clones to choose from when you start a ticket, one per line. Empty uses ~/.corpus.',
		default: '',
		maxLength: 4000
	},
	'conductor.readyWhen': {
		key: 'conductor.readyWhen',
		type: 'enum',
		label: 'Ready for you when',
		description: 'When a ticket moves from Agents working to Ready for you.',
		options: [
			{ value: 'draft_pr', label: 'A draft PR is up' },
			{ value: 'ci_green', label: 'PR is ready for review and CI passes' }
		],
		default: 'draft_pr'
	},
	'conductor.preReview': {
		key: 'conductor.preReview',
		type: 'boolean',
		label: 'Review before the PR',
		description:
			'Add your Integrator and Breaker reviewers to each ticket thread; the Builder addresses their findings before the PR opens.',
		default: true
	},
	'conductor.repoNotes': {
		key: 'conductor.repoNotes',
		type: 'string',
		label: 'Repository notes',
		description: 'JSON: repository path -> what it is, shown to agents.',
		default: '{}',
		maxLength: 20000
	}
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
type ValueOf<D> = D extends { type: 'boolean' }
	? boolean
	: D extends { type: 'enum'; options: readonly { value: infer V }[] }
		? V
		: D extends { type: 'number' }
			? number
			: string;
export type SettingValue<K extends SettingKey> = ValueOf<(typeof SETTINGS)[K]>;
export type SettingValues<K extends SettingKey = SettingKey> = { [P in K]: SettingValue<P> };

export function isSettingKey(key: string): key is SettingKey {
	return Object.hasOwn(SETTINGS, key);
}

export function settingSchema(def: SettingDef): z.ZodType {
	switch (def.type) {
		case 'boolean':
			return z.boolean();
		case 'enum':
			return z.enum(def.options.map((o) => o.value) as [string, ...string[]]);
		case 'number': {
			let s = z.number().finite();
			if (def.min !== undefined) s = s.min(def.min);
			if (def.max !== undefined) s = s.max(def.max);
			return s;
		}
		case 'string':
			return z.string().max(def.maxLength ?? 2000);
	}
}

/** A stored value, or the default when it's missing or no longer valid (e.g. a removed option). */
export function readSetting<K extends SettingKey>(key: K, stored: unknown): SettingValue<K> {
	const def = SETTINGS[key] as SettingDef;
	if (stored === undefined) return def.default as SettingValue<K>;
	const parsed = settingSchema(def).safeParse(stored);
	return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
}

/** Throws a readable message for an unknown key or a value of the wrong type. */
export function parseSetting(key: string, value: unknown): { key: SettingKey; value: unknown } {
	if (!isSettingKey(key)) throw new Error(`Unknown setting: ${key}`);
	const parsed = settingSchema(SETTINGS[key] as SettingDef).safeParse(value);
	if (!parsed.success) throw new Error(`Invalid value for ${key}`);
	return { key, value: parsed.data };
}
