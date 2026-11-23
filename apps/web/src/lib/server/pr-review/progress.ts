// What a running review is doing right now. Held in memory: it only means anything during a live run,
// and a server restart already marks that run interrupted.
import type { ReviewerRole } from './findings';

export type ReviewStage = 'preparing' | 'downloading' | 'reviewing' | 'crosschecking' | 'voicing';
export type ReviewerState = 'waiting' | 'working' | 'retrying' | 'checking' | 'done' | 'failed';

interface ReviewerProgress {
	role: ReviewerRole;
	state: ReviewerState;
	actions: number;
	/** Untrusted: it can quote file names from the PR. */
	lastAction: string | null;
	lastActivityAt: number;
}

export interface ReviewProgress {
	stage: ReviewStage;
	startedAt: number;
	/** When each stage began, in order, so a run can say where its time went. */
	marks: { stage: ReviewStage; at: number }[];
	reviewers: ReviewerProgress[];
}

/** Seconds spent in each stage, in order. The current stage runs until `now`. */
export type StageTimings = { stage: ReviewStage; seconds: number }[];

/** What the orchestrator reports as a review moves along. */
export interface ProgressReporter {
	stage: (stage: ReviewStage) => void;
	reviewer: (role: ReviewerRole, state: ReviewerState) => void;
	/** Any output counts as a sign of life. A described action also becomes the latest action. */
	activity: (role: ReviewerRole, action: string | null) => void;
}

export function createProgress(roles: readonly ReviewerRole[], now = Date.now()): ReviewProgress {
	return {
		stage: 'preparing',
		startedAt: now,
		marks: [{ stage: 'preparing', at: now }],
		reviewers: roles.map((role) => ({
			role,
			state: 'waiting',
			actions: 0,
			lastAction: null,
			lastActivityAt: now
		}))
	};
}

export function progressReporter(
	progress: ReviewProgress,
	clock: () => number = Date.now
): ProgressReporter {
	const find = (role: ReviewerRole) => progress.reviewers.find((r) => r.role === role);
	return {
		stage: (stage) => {
			if (progress.stage === stage) return;
			progress.stage = stage;
			progress.marks.push({ stage, at: clock() });
		},
		reviewer: (role, state) => {
			const reviewer = find(role);
			if (!reviewer) return;
			reviewer.state = state;
			reviewer.lastActivityAt = clock();
		},
		activity: (role, action) => {
			const reviewer = find(role);
			if (!reviewer) return;
			reviewer.lastActivityAt = clock();
			if (!action) return;
			reviewer.lastAction = action;
			reviewer.actions++;
		}
	};
}

export function stageTimings(progress: ReviewProgress, now = Date.now()): StageTimings {
	return progress.marks.map((m, i) => ({
		stage: m.stage,
		seconds: Math.max(0, Math.round(((progress.marks[i + 1]?.at ?? now) - m.at) / 1000))
	}));
}

/** Durations rather than timestamps, so the browser's clock doesn't have to agree with the server's. */
export function progressView(progress: ReviewProgress, now = Date.now()) {
	return {
		stage: progress.stage,
		elapsedSeconds: Math.max(0, Math.round((now - progress.startedAt) / 1000)),
		timings: stageTimings(progress, now),
		reviewers: progress.reviewers.map(({ role, state, actions, lastAction, lastActivityAt }) => ({
			role,
			state,
			actions,
			lastAction,
			quietSeconds: Math.max(0, Math.round((now - lastActivityAt) / 1000))
		}))
	};
}
