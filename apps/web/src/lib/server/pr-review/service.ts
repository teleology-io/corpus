// Integration Review for the signed-in user: database, GitHub and the background run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { error } from '@sveltejs/kit';
import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { accessToken } from '@corpus/db/connections';
import {
	parsePullRef,
	postPullReview,
	pullDetails,
	pullDiff,
	pullTarball,
	type PullRef
} from '@corpus/core/integrations';
import { agentEnv, command } from '../wrx/core.js';
import { buildBundle, removeTree } from './bundle';
import { uniqueIds, type Finding } from './findings';
import { DEFAULT_SLOTS, resolveSlots, reviewPullRequest, ROLES } from './orchestrate';
import { buildGithubReview } from './post';
import { PERSONAS } from './prompts';
import {
	InvalidReviewerSettings,
	normalizeReviewerSettings,
	readReviewerSettings,
	writeReviewerSettings
} from './reviewers';
import { createProgress, progressReporter, progressView, type ReviewProgress } from './progress';
import { reviewEnv, runAgent, type ReviewProvider, type Spawn } from './runner';

const { prReview: review, integrationItem: item, integrationConnection: conn } = schema;

// Survives Vite HMR like Workbench's hosts. userId -> review id, so one review runs per user.
const active: Map<string, string> = ((
	globalThis as { __prReviewActive?: Map<string, string> }
).__prReviewActive ??= new Map());

// Review id -> what that run is doing. Survives HMR for the same reason.
const liveProgress: Map<string, ReviewProgress> = ((
	globalThis as { __prReviewProgress?: Map<string, ReviewProgress> }
).__prReviewProgress ??= new Map());

const userDir = (userId: string) =>
	path.join(path.resolve(process.env.WRX_DATA || '.wrx'), userId.replace(/[^\w-]/g, '_'));
const bundleDir = (userId: string, id: string) => path.join(userDir(userId), 'pr-reviews', id);
const settingsFile = (userId: string) => path.join(userDir(userId), 'review-settings.json');

/** Each reviewer as the settings dialog edits it, with the built-in persona to restore. */
export function getReviewerSettings(userId: string) {
	const settings = readReviewerSettings(settingsFile(userId));
	return {
		reviewers: ROLES.map((role) => ({
			role,
			model: settings[role].model,
			persona: settings[role].persona ?? PERSONAS[role],
			defaultPersona: PERSONAS[role]
		})),
		voice: { model: settings.voice.model, persona: settings.voice.persona ?? '' }
	};
}

export function saveReviewerSettings(userId: string, input: unknown) {
	try {
		writeReviewerSettings(settingsFile(userId), normalizeReviewerSettings(input));
	} catch (e) {
		if (e instanceof InvalidReviewerSettings) error(400, e.message);
		throw e;
	}
}

async function installed(): Promise<Record<ReviewProvider, boolean>> {
	const probe = (name: string) =>
		command(name, ['--version'], { timeout: 5000, env: agentEnv() }).then(
			() => true,
			() => false
		);
	const [claude, codex] = await Promise.all([probe('claude'), probe('codex')]);
	return { claude, codex };
}

/** A running row with no live run belongs to a server that restarted. */
async function markInterrupted(userId: string) {
	const running = active.get(userId);
	await db
		.update(review)
		.set({ status: 'interrupted', error: 'The server restarted during this review.' })
		.where(
			and(
				eq(review.userId, userId),
				eq(review.status, 'running'),
				running ? notInArray(review.id, [running]) : undefined
			)
		);
}

/** Open PRs that asked for your review, each with its newest review. */
export async function listExternalReviews(userId: string) {
	await markInterrupted(userId);
	const items = await db
		.select({
			id: item.id,
			title: item.title,
			subtitle: item.subtitle,
			url: item.url,
			state: item.state,
			updatedAt: item.externalUpdatedAt,
			payload: item.payload
		})
		.from(item)
		.innerJoin(conn, eq(item.connectionId, conn.id))
		.where(
			and(
				eq(conn.userId, userId),
				eq(conn.provider, 'github'),
				eq(item.kind, 'review_request'),
				isNull(item.resolvedAt)
			)
		)
		.orderBy(desc(item.externalUpdatedAt));
	const reviews = await db
		.select()
		.from(review)
		.where(eq(review.userId, userId))
		.orderBy(desc(review.createdAt));
	const withProgress = (r: (typeof reviews)[number]) => {
		const progress = liveProgress.get(r.id);
		return {
			...r,
			findings: withUniqueIds(r.findings),
			progress: progress ? progressView(progress) : null
		};
	};
	return items.map((i) => {
		const latest = reviews.find((r) => r.itemId === i.id);
		return {
			...i,
			author: (i.payload as { author?: string } | null)?.author ?? null,
			payload: undefined,
			review: latest ? withProgress(latest) : null
		};
	});
}

async function ownItem(userId: string, itemId: string) {
	const [row] = await db
		.select({ subtitle: item.subtitle, connection: conn })
		.from(item)
		.innerJoin(conn, eq(item.connectionId, conn.id))
		.where(and(eq(item.id, itemId), eq(conn.userId, userId), eq(conn.provider, 'github')))
		.limit(1);
	const ref = parsePullRef(row?.subtitle);
	if (!row || !ref) error(404, 'Pull request not found');
	return { connection: row.connection, ref };
}

// Reviews stored before ids were made unique can repeat one, so ids are fixed up on every read.
const withUniqueIds = (findings: Record<string, unknown>[]) =>
	uniqueIds(findings as unknown as Finding[]) as unknown as Record<string, unknown>[];

async function ownReview(userId: string, reviewId: string) {
	const [row] = await db
		.select()
		.from(review)
		.where(and(eq(review.id, reviewId), eq(review.userId, userId)))
		.limit(1);
	if (!row) error(404, 'Review not found');
	return { ...row, findings: withUniqueIds(row.findings) };
}

/** Starts in the background and returns the running row. Failures end up on the row, not lost. */
export async function startExternalReview(userId: string, itemId: string) {
	if (active.has(userId)) error(409, 'A review is already running. Try again when it finishes.');
	// Claimed before the first await, so a double click can't start two runs.
	active.set(userId, '');
	try {
		const { connection, ref } = await ownItem(userId, itemId);
		const token = await accessToken(connection);
		const pr = await pullDetails(token, ref);
		const [row] = await db
			.insert(review)
			.values({ itemId, userId, headSha: pr.headSha, status: 'running' })
			.onConflictDoUpdate({
				target: [review.itemId, review.headSha],
				set: {
					status: 'running',
					error: null,
					findings: [],
					questions: [],
					notReviewed: [],
					notices: [],
					costUsd: 0,
					postedUrl: null
				}
			})
			.returning();
		active.set(userId, row.id);
		const progress = createProgress(ROLES);
		liveProgress.set(row.id, progress);
		void execute(userId, row.id, token, ref, pr, progress).finally(() => {
			active.delete(userId);
			liveProgress.delete(row.id);
		});
		return row;
	} catch (e) {
		active.delete(userId);
		throw e;
	}
}

async function execute(
	userId: string,
	id: string,
	token: string,
	ref: PullRef,
	pr: Awaited<ReturnType<typeof pullDetails>>,
	progress: ReviewProgress
) {
	const dir = bundleDir(userId, id);
	try {
		const settings = readReviewerSettings(settingsFile(userId));
		const { slots, notices } = resolveSlots(
			ROLES.map((role, i) => ({
				provider: DEFAULT_SLOTS[i].provider,
				model: settings[role].model
			})),
			await installed()
		);
		if (!slots) throw new Error(notices.join(' '));
		fs.rmSync(dir, { recursive: true, force: true });
		const bundle = await buildBundle({
			dir,
			pr,
			diff: await pullDiff(token, ref),
			tarball: (sha) => pullTarball(token, ref, sha)
		});
		await db
			.update(review)
			.set({ treeSha: bundle.treeSha, slots, notices })
			.where(eq(review.id, id));
		const env = reviewEnv(agentEnv());
		const outcome = await reviewPullRequest({
			slots,
			personas: { integrator: settings.integrator.persona, breaker: settings.breaker.persona },
			voice: settings.voice.persona
				? {
						slot: { provider: slots[0].provider, model: settings.voice.model, tools: false },
						text: settings.voice.persona
					}
				: null,
			bundleDir: dir,
			treeState: bundle.treeState,
			partial: bundle.partial,
			headSha: pr.headSha,
			deps: {
				// cwd is the bundle root, so the PR's own tree/ isn't loaded as project config.
				run: (slot, prompt, onActivity) =>
					runAgent({ slot, prompt, cwd: dir, env, spawn: spawn as unknown as Spawn, onActivity }),
				currentHead: async () => (await pullDetails(token, ref)).headSha,
				progress: progressReporter(progress)
			}
		});
		await db
			.update(review)
			.set({
				status: outcome.status,
				findings: outcome.findings as unknown as Record<string, unknown>[],
				questions: outcome.questions,
				notReviewed: outcome.notReviewed,
				notices: [...notices, ...outcome.notices],
				costUsd: outcome.costUsd,
				error: outcome.error
			})
			.where(eq(review.id, id));
	} catch (e) {
		await db
			.update(review)
			.set({ status: 'failed', error: (e as Error).message.slice(0, 2000) })
			.where(eq(review.id, id));
	} finally {
		removeTree(dir);
	}
}

export async function dismissFinding(userId: string, reviewId: string, findingId: string) {
	const row = await ownReview(userId, reviewId);
	const findings = row.findings.map((f) =>
		f.id === findingId ? { ...f, outcome: f.outcome === 'dismissed' ? 'open' : 'dismissed' } : f
	);
	await db.update(review).set({ findings }).where(eq(review.id, reviewId));
}

const MAX_CUSTOM_LENGTH = 20000;

/** Replaces what gets posted for one finding with the user's own text. Blank text goes back to the finding. */
export async function setCustomComment(
	userId: string,
	reviewId: string,
	findingId: string,
	text: unknown
) {
	const row = await ownReview(userId, reviewId);
	if (row.postedUrl) error(409, 'This review is already posted.');
	const custom = typeof text === 'string' ? text.trim() : '';
	if (custom.length > MAX_CUSTOM_LENGTH) error(400, 'That comment is too long.');
	if (!row.findings.some((f) => f.id === findingId)) error(404, 'Finding not found');
	const findings = row.findings.map((f) => {
		if (f.id !== findingId) return f;
		const { custom: _, ...rest } = f;
		return custom ? { ...rest, custom } : rest;
	});
	await db.update(review).set({ findings }).where(eq(review.id, reviewId));
}

async function prepareGithubReview(userId: string, reviewId: string) {
	const row = await ownReview(userId, reviewId);
	const { connection, ref } = await ownItem(userId, row.itemId);
	const token = await accessToken(connection);
	const [pr, diff] = await Promise.all([pullDetails(token, ref), pullDiff(token, ref)]);
	const built = buildGithubReview(row.findings as unknown as Finding[], diff.patch);
	return { row, ref, token, built, headMoved: pr.headSha !== row.headSha };
}

/** Exactly what Post would send. */
export async function previewGithubReview(userId: string, reviewId: string) {
	const { built, headMoved } = await prepareGithubReview(userId, reviewId);
	return { body: built.body, comments: built.comments, headMoved };
}

export async function postGithubReview(userId: string, reviewId: string) {
	const { row, ref, token, built, headMoved } = await prepareGithubReview(userId, reviewId);
	if (headMoved) error(409, 'New commits landed since this review. Re-review before posting.');
	if (!built.ids.length) error(400, 'There are no findings to post.');
	const { url } = await postPullReview(token, ref, {
		commitSha: row.headSha,
		body: built.body,
		comments: built.comments
	});
	const posted = new Set(built.ids);
	await db
		.update(review)
		.set({
			postedUrl: url,
			findings: row.findings.map((f) =>
				posted.has(f.id as string) ? { ...f, outcome: 'posted' } : f
			)
		})
		.where(eq(review.id, reviewId));
	return { url };
}
