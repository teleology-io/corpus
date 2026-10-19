import type { ExternalItem } from './types';

/** Fingerprint of fields whose change should surface to the user. */
export function itemHash(item: ExternalItem): string {
	return JSON.stringify([item.kind, item.title, item.state ?? null, item.dueDate ?? null]);
}

export interface ExistingItem {
	id: string;
	externalId: string;
	hash: string;
	resolvedAt: Date | null;
}

export interface ItemDiff {
	created: ExternalItem[];
	changed: { item: ExternalItem; previous: ExistingItem }[];
	unchanged: ExternalItem[];
	/** Existing open items the provider no longer returns */
	resolved: ExistingItem[];
	/** Previously resolved items that came back */
	reopened: { item: ExternalItem; previous: ExistingItem }[];
}

export function diffItems(existing: ExistingItem[], incoming: ExternalItem[]): ItemDiff {
	const byId = new Map(existing.map((e) => [e.externalId, e]));
	const seen = new Set<string>();
	const diff: ItemDiff = { created: [], changed: [], unchanged: [], resolved: [], reopened: [] };
	for (const item of incoming) {
		seen.add(item.externalId);
		const prev = byId.get(item.externalId);
		if (!prev) diff.created.push(item);
		else if (prev.resolvedAt) diff.reopened.push({ item, previous: prev });
		else if (prev.hash !== itemHash(item)) diff.changed.push({ item, previous: prev });
		else diff.unchanged.push(item);
	}
	for (const prev of existing) {
		if (!seen.has(prev.externalId) && !prev.resolvedAt) diff.resolved.push(prev);
	}
	return diff;
}
