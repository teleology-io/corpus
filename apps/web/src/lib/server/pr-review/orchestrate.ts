// One review, end to end, with every outside effect injected. See prompts.ts for the reviewers.
import {
	applyCrosscheck,
	finalStatus,
	parseCrosscheck,
	parseReview,
	type Finding,
	type ReviewStatus,
	type ReviewerResult,
	type ReviewerRole
} from './findings';
import type { ProgressReporter } from './progress';
import { crosscheckPrompt, reviewPrompt } from './prompts';
import {
	CODEX_ALLOWED_FOR_PR_REVIEW,
	type AgentRun,
	type ReviewProvider,
	type ReviewSlot
} from './runner';

export const ROLES: [ReviewerRole, ReviewerRole] = ['integrator', 'breaker'];

export const DEFAULT_SLOTS: [ReviewSlot, ReviewSlot] = [
	{ provider: 'claude', model: '' },
	{ provider: 'claude', model: '' }
];

export interface ResolvedSlots {
	slots: [ReviewSlot, ReviewSlot] | null;
	notices: string[];
}

/**
 * Applies what this machine can run. A slot that can't run moves to a usable provider with a notice,
 * so a Claude-only machine still gets two reviewers. Null means no reviewer can run at all.
 */
export function resolveSlots(
	wanted: ReviewSlot[] | undefined,
	installed: Record<ReviewProvider, boolean>,
	codexAllowed = CODEX_ALLOWED_FOR_PR_REVIEW
): ResolvedSlots {
	const usable = (p: ReviewProvider) => installed[p] && (p !== 'codex' || codexAllowed);
	const fallback = (['claude', 'codex'] as const).find(usable);
	if (!fallback)
		return { slots: null, notices: ['No reviewer CLI is available on this computer.'] };
	const notices: string[] = [];
	const slots = ROLES.map((role, i) => {
		const slot = wanted?.[i] ?? DEFAULT_SLOTS[i];
		if (usable(slot.provider)) return slot;
		notices.push(
			`The ${role} slot asked for ${slot.provider}, which ${installed[slot.provider] ? 'is not yet allowed for PR review' : 'is not installed here'}. Used ${fallback} instead.`
		);
		return { provider: fallback, model: '' };
	}) as [ReviewSlot, ReviewSlot];
	return { slots, notices };
}

export interface ReviewDeps {
	/** Runs one reviewer in the bundle. */
	run: (
		slot: ReviewSlot,
		prompt: string,
		onActivity?: (action: string | null) => void
	) => Promise<AgentRun>;
	/** Latest head, to catch a push that landed during the review. */
	currentHead: () => Promise<string>;
	progress?: ProgressReporter;
}

export interface ReviewOutcome {
	status: ReviewStatus;
	findings: Finding[];
	questions: string[];
	notReviewed: { path: string; reason: string }[];
	costUsd: number;
	error: string | null;
}

export async function reviewPullRequest(input: {
	slots: [ReviewSlot, ReviewSlot];
	/** Replaces a reviewer's built-in persona. */
	personas?: Partial<Record<ReviewerRole, string | null>>;
	bundleDir: string;
	treeState: string;
	partial: boolean;
	headSha: string;
	deps: ReviewDeps;
}): Promise<ReviewOutcome> {
	const { slots, personas, bundleDir, treeState, deps } = input;
	let costUsd = 0;
	const errors: string[] = [];
	const call = async (slot: ReviewSlot, prompt: string, role: ReviewerRole) => {
		const run = await deps.run(slot, prompt, (action) => deps.progress?.activity(role, action));
		costUsd += run.costUsd;
		if (run.error) errors.push(run.error);
		return run;
	};

	// One retry on unusable output. A reviewer that still fails makes the whole review failed.
	const firstPass = async (i: number): Promise<ReviewerResult | null> => {
		const prompt = reviewPrompt(ROLES[i], bundleDir, treeState, personas?.[ROLES[i]]);
		for (let attempt = 0; attempt < 2; attempt++) {
			deps.progress?.reviewer(ROLES[i], attempt ? 'retrying' : 'working');
			const run = await call(slots[i], prompt, ROLES[i]);
			if (run.error) continue;
			const parsed = parseReview(run.text, ROLES[i]);
			if (parsed) {
				deps.progress?.reviewer(ROLES[i], 'done');
				return parsed;
			}
			errors.push(`The ${ROLES[i]} returned output that could not be read.`);
		}
		deps.progress?.reviewer(ROLES[i], 'failed');
		return null;
	};
	deps.progress?.stage('reviewing');
	const results = await Promise.all(ROLES.map((_, i) => firstPass(i)));

	let findings = results.flatMap((r) => r?.findings ?? []);

	// Each reviewer tests the other's blockers. Only run when both finished: a reviewer that failed
	// already makes this review failed, and its findings should reach you untouched.
	if (results.every(Boolean)) {
		if (findings.some((f) => f.severity === 'blocker')) deps.progress?.stage('crosschecking');
		const checks = await Promise.all(
			ROLES.map(async (role, i) => {
				const blockers = findings.filter((f) => f.severity === 'blocker' && f.reviewer !== role);
				if (!blockers.length) return [];
				deps.progress?.reviewer(role, 'checking');
				const run = await call(
					slots[i],
					crosscheckPrompt(role, bundleDir, treeState, blockers, personas?.[role]),
					role
				);
				deps.progress?.reviewer(role, 'done');
				return { blockers, results: run.error ? null : parseCrosscheck(run.text) };
			})
		);
		for (const check of checks) {
			if (Array.isArray(check)) continue;
			const ids = new Set(check.blockers.map((b) => b.id));
			const tested = applyCrosscheck(
				findings.filter((f) => ids.has(f.id)),
				check.results
			);
			findings = findings.map((f) => tested.find((t) => t.id === f.id) ?? f);
		}
	}

	const base = {
		findings,
		questions: results.flatMap((r) => r?.questions ?? []),
		notReviewed: results.flatMap((r) => r?.notReviewed ?? []),
		costUsd,
		error: null
	};
	const status = finalStatus({ results, partial: input.partial, findings });
	if (status === 'failed') return { ...base, status, error: errors.join(' ') || 'Review failed' };

	if ((await deps.currentHead()) !== input.headSha) return { ...base, status: 'stale' };
	return { ...base, status };
}
