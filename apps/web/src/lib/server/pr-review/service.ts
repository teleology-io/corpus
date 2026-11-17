// Integration Review for the signed-in user: database, GitHub and the background run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { error } from '@sveltejs/kit';
import { and, desc, eq, gte, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import { db, schema } from '@corpus/db';
import { accessToken } from '@corpus/db/connections';
import {
	parsePullRef,
	postPullReview,
	pullDetails,
	pullDiff,
	pullHeads,
	pullTarball,
	type PullHead,
	type PullRef
} from '@corpus/core/integrations';
import { agentEnv, command } from '../wrx/core.js';
import { buildBundle, removeTree } from './bundle';
import { liveFindings, uniqueIds, type Finding } from './findings';
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

// Posting a review clears the request on GitHub, which resolves the item. A PR you reviewed stays
// listed this long after that, while it's open, so you can re-review the author's fixes.
const FOLLOW_DAYS = 30;
const HEADS_TTL_MS = 60_000;

type HeadsEntry = { key: string; at: number; heads: Record<string, PullHead> };
// userId -> the last live lookup, so the 5s poll during a run doesn't call GitHub each time.
const headsCache: Map<string, HeadsEntry> = ((
	globalThis as { __prReviewHeads?: Map<string, HeadsEntry> }
).__prReviewHeads ??= new Map());

const nodeId = (externalId: string) => externalId.slice(externalId.indexOf(':') + 1);

/** Current state and head by external id. Best effort: a failed lookup just shows no live state. */
async function liveHeads(
	userId: string,
	rows: { externalId: string; connection: typeof conn.$inferSelect }[]
) {
	const key = rows
		.map((r) => r.externalId)
		.sort()
		.join(',');
	const cached = headsCache.get(userId);
	if (cached && cached.key === key && Date.now() - cached.at < HEADS_TTL_MS) return cached.heads;
	const byConnection = new Map<string, typeof rows>();
	for (const r of rows)
		byConnection.set(r.connection.id, [...(byConnection.get(r.connection.id) ?? []), r]);
	const heads: Record<string, PullHead> = {};
	await Promise.all(
		[...byConnection.values()].map(async (group) => {
			try {
				const found = await pullHeads(
					await accessToken(group[0].connection),
					group.map((r) => nodeId(r.externalId))
				);
				for (const r of group) {
					const h = found[nodeId(r.externalId)];
					if (h) heads[r.externalId] = h;
				}
			} catch (e) {
				console.warn('[pr-review] live PR lookup failed:', (e as Error).message);
			}
		})
	);
	headsCache.set(userId, { key, at: Date.now(), heads });
	return heads;
}

/**
 * Open PRs that asked for your review, plus open ones you reviewed after GitHub cleared the request,
 * each with its newest review and the PR's current head.
 */
export async function listExternalReviews(userId: string) {
	await markInterrupted(userId);
	const reviews = await db
		.select()
		.from(review)
		.where(eq(review.userId, userId))
		.orderBy(desc(review.createdAt));
	const reviewed = [...new Set(reviews.map((r) => r.itemId))];
	const cutoff = new Date(Date.now() - FOLLOW_DAYS * 86_400_000);
	const rows = await db
		.select({
			id: item.id,
			externalId: item.externalId,
			title: item.title,
			subtitle: item.subtitle,
			url: item.url,
			state: item.state,
			updatedAt: item.externalUpdatedAt,
			resolvedAt: item.resolvedAt,
			payload: item.payload,
			connection: conn
		})
		.from(item)
		.innerJoin(conn, eq(item.connectionId, conn.id))
		.where(
			and(
				eq(conn.userId, userId),
				eq(conn.provider, 'github'),
				eq(item.kind, 'review_request'),
				reviewed.length
					? or(
							isNull(item.resolvedAt),
							and(inArray(item.id, reviewed), gte(item.resolvedAt, cutoff))
						)
					: isNull(item.resolvedAt)
			)
		)
		.orderBy(desc(item.externalUpdatedAt));
	// The worker records why an item left the feed; a merged or closed PR has nothing left to review.
	const items = rows.filter((i) => {
		const outcome = (i.payload as { outcome?: string } | null)?.outcome;
		return !i.resolvedAt || (outcome !== 'merged' && outcome !== 'closed');
	});
	const heads = await liveHeads(userId, items);
	const withProgress = (r: (typeof reviews)[number]) => {
		const progress = liveProgress.get(r.id);
		return {
			...r,
			findings: withUniqueIds(r.findings),
			progress: progress ? progressView(progress) : null
		};
	};
	return (
		items
			// Merged or closed after the request cleared, which the worker no longer sees.
			.filter((i) => !i.resolvedAt || (heads[i.externalId]?.state ?? 'OPEN') === 'OPEN')
			.map(({ connection: _, externalId, payload, resolvedAt, ...i }) => {
				const latest = reviews.find((r) => r.itemId === i.id);
				return {
					...i,
					author: (payload as { author?: string } | null)?.author ?? null,
					/** GitHub no longer lists you as a requested reviewer, usually because you reviewed it. */
					requestCleared: !!resolvedAt,
					/** The PR's head now, when GitHub answered. Differs from the review's after a push. */
					headSha: heads[externalId]?.headSha ?? null,
					review: latest ? withProgress(latest) : null
				};
			})
	);
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

/** The PR's current diff, for reading next to the findings. */
export async function externalReviewDiff(userId: string, itemId: string) {
	const { connection, ref } = await ownItem(userId, itemId);
	return pullDiff(await accessToken(connection), ref);
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
		const previous = await previousFindings(userId, itemId, pr.headSha);
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
					summary: null,
					previous: [],
					postedUrl: null,
					postedBy: null,
					approvedUrl: null
				}
			})
			.returning();
		active.set(userId, row.id);
		const progress = createProgress(ROLES);
		liveProgress.set(row.id, progress);
		void execute(userId, row.id, token, ref, pr, progress, previous).finally(() => {
			active.delete(userId);
			liveProgress.delete(row.id);
		});
		return row;
	} catch (e) {
		active.delete(userId);
		throw e;
	}
}

/**
 * What the newest review of an earlier commit left standing, for the reviewers to recheck. Dismissed
 * findings stay out: you already decided they don't matter.
 */
async function previousFindings(userId: string, itemId: string, headSha: string) {
	const [row] = await db
		.select({ findings: review.findings })
		.from(review)
		.where(
			and(
				eq(review.userId, userId),
				eq(review.itemId, itemId),
				ne(review.headSha, headSha),
				inArray(review.status, ['findings', 'partial', 'stale'])
			)
		)
		.orderBy(desc(review.createdAt))
		.limit(1);
	if (!row) return [];
	return liveFindings(withUniqueIds(row.findings) as unknown as Finding[]).filter(
		(f) => f.outcome !== 'dismissed'
	);
}

async function execute(
	userId: string,
	id: string,
	token: string,
	ref: PullRef,
	pr: Awaited<ReturnType<typeof pullDetails>>,
	progress: ReviewProgress,
	previous: Finding[]
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
			previous,
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
				summary: outcome.summary || null,
				previous: outcome.previous,
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

const APPROVABLE = ['clean', 'findings', 'partial'];

/**
 * Approves on GitHub as you. Findings not yet posted or dismissed go with it as comments, so an
 * approval never silently drops something you meant to say.
 */
export async function approveGithubReview(userId: string, reviewId: string) {
	const { row, ref, token, built, headMoved } = await prepareGithubReview(userId, reviewId);
	if (headMoved) error(409, 'New commits landed since this review. Re-review before approving.');
	if (row.approvedUrl) error(409, 'You already approved this commit.');
	if (!APPROVABLE.includes(row.status)) error(409, 'Only a finished review can be approved.');
	const { url, author } = await postPullReview(token, ref, {
		commitSha: row.headSha,
		event: 'APPROVE',
		body: built.ids.length ? built.body : '',
		comments: built.comments
	});
	const posted = new Set(built.ids);
	await db
		.update(review)
		.set({
			approvedUrl: url,
			postedUrl: row.postedUrl ?? url,
			postedBy: row.postedBy ?? author,
			findings: row.findings.map((f) =>
				posted.has(f.id as string) ? { ...f, outcome: 'posted' } : f
			)
		})
		.where(eq(review.id, reviewId));
	return { url };
}

export async function postGithubReview(userId: string, reviewId: string) {
	const { row, ref, token, built, headMoved } = await prepareGithubReview(userId, reviewId);
	if (headMoved) error(409, 'New commits landed since this review. Re-review before posting.');
	if (!built.ids.length) error(400, 'There are no findings to post.');
	const { url, author } = await postPullReview(token, ref, {
		commitSha: row.headSha,
		body: built.body,
		comments: built.comments
	});
	const posted = new Set(built.ids);
	await db
		.update(review)
		.set({
			postedUrl: url,
			// GitHub's record of who posted it; the standup only says "reviewed" when this matches
			// the connection's account.
			postedBy: author,
			findings: row.findings.map((f) =>
				posted.has(f.id as string) ? { ...f, outcome: 'posted' } : f
			)
		})
		.where(eq(review.id, reviewId));
	return { url };
}
