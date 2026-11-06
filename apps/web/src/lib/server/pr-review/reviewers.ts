// Each reviewer's model and persona, saved per user. Kept beside Workbench's other per-user files
// because the models a machine can run depend on that machine's CLI and cloud setup.
import fs from 'node:fs';
import path from 'node:path';
import type { ReviewerRole } from './findings';
import { PERSONAS } from './prompts';

export const MAX_PERSONA_LENGTH = 8000;
// Becomes a CLI argument, so it must never be readable as a flag. Allows Bedrock ids and ARNs.
const MODEL_ID = /^[A-Za-z0-9][\w.:/@[\]-]*$/;
const ROLES = Object.keys(PERSONAS) as ReviewerRole[];

export interface ReviewerSetting {
	/** Empty means the CLI's own default. */
	model: string;
	/** Null means the built-in persona. */
	persona: string | null;
}
export type ReviewerSettings = Record<ReviewerRole, ReviewerSetting>;

export class InvalidReviewerSettings extends Error {}

const defaults = (): ReviewerSettings => ({
	integrator: { model: '', persona: null },
	breaker: { model: '', persona: null }
});

/** Throws InvalidReviewerSettings on anything that can't be saved as is. */
export function normalizeReviewerSettings(input: unknown): ReviewerSettings {
	const settings = defaults();
	const source = (input ?? {}) as Record<
		string,
		{ model?: unknown; persona?: unknown } | undefined
	>;
	for (const role of ROLES) {
		const model = typeof source[role]?.model === 'string' ? source[role].model.trim() : '';
		if (model && !MODEL_ID.test(model))
			throw new InvalidReviewerSettings(`The ${role} model ID "${model}" isn't valid.`);
		// A browser submits textarea line breaks as CRLF, which would never match the built-in text.
		const persona =
			typeof source[role]?.persona === 'string'
				? source[role].persona.replaceAll('\r\n', '\n').trim()
				: '';
		if (persona.length > MAX_PERSONA_LENGTH)
			throw new InvalidReviewerSettings(
				`The ${role} persona is over ${MAX_PERSONA_LENGTH} characters.`
			);
		settings[role] = {
			model,
			persona: persona && persona !== PERSONAS[role] ? persona : null
		};
	}
	return settings;
}

/** A missing or damaged file means the defaults: it must never stop a review from running. */
export function readReviewerSettings(file: string): ReviewerSettings {
	try {
		return normalizeReviewerSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
	} catch {
		return defaults();
	}
}

export function writeReviewerSettings(file: string, settings: ReviewerSettings) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
