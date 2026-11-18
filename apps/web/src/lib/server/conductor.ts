// Conductor: the board that runs the user's day. Cards are seeded from integration items (tickets
// assigned to you, PRs asking for your review); columns are stored, and reviews advance on their own.
import { dev } from '$app/env';
import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db, optionalEnv, schema } from '@corpus/db';
import { accessToken } from '@corpus/db/connections';
import { createPull, pullDetails } from '@corpus/core/integrations';
import { itemPreview } from './integrations';
import { listExternalReviews } from './pr-review/service';
import { getSettings } from './settings';
import {
	conductorChat,
	conductorPush,
	conductorRepos,
	conductorSend,
	conductorStart
} from './wrx/index.js';

const { conductorCard: card, conductorEvent: event, integrationItem: item } = schema;
const conn = schema.integrationConnection;

export const COLUMNS = ['inbox', 'today', 'working', 'ready', 'done'] as const;
export type Column = (typeof COLUMNS)[number];

/**
 * Hidden feature. CONDUCTOR_ALLOWED_EMAILS (comma-separated) lists who sees it. Unset, it is off
 * unless the dev server was started with CONDUCTOR=1 (`make dev conductor`); never on in production
 * without the list.
 */
export function conductorAllowed(email: string) {
	const list = optionalEnv('CONDUCTOR_ALLOWED_EMAILS');
	if (!list) return dev && optionalEnv('CONDUCTOR') === '1';
	return list
		.split(',')
		.map((e) => e.trim().toLowerCase())
		.includes(email.toLowerCase());
}

export function requireConductor(email: string) {
	if (!conductorAllowed(email)) error(404, 'Not found');
}

/** The user's calendar day, YYYY-MM-DD. */
export const localDay = (tz: string, at = new Date()) =>
	new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);

type Review = Awaited<ReturnType<typeof listExternalReviews>>[number];

/** Where a review card belongs given its latest review. Null leaves the stored column alone. */
function reviewColumn(r: Review | undefined): Column | null {
	const latest = r?.review;
	if (!latest) return null;
	if (latest.approvedUrl || latest.postedUrl) return 'done';
	if (latest.status === 'running') return 'working';
	if (['clean', 'findings', 'partial'].includes(latest.status)) return 'ready';
	return null;
}

const ORDER = Object.fromEntries(COLUMNS.map((c, i) => [c, i])) as Record<Column, number>;

/** One repository a ticket's agents work in: its worktree, branch and (once opened) PR. */
interface RepoMeta {
	workspaceId: string;
	path: string;
	name: string;
	branch: string | null;
	base: string | null;
	pr?: { owner: string; repo: string; number: number; url: string } | null;
}

/** What Conductor keeps on a ticket card between loads. */
interface TicketMeta {
	/** The thread's own workspace (the first repository). */
	workspaceId?: string;
	repos?: RepoMeta[];
	/** Single-repository cards from before `repos`. */
	branch?: string | null;
	base?: string | null;
	/** Why the ticket needs you while it sits in Agents working. */
	blocked?: string | null;
	/** The agent's closing summary. */
	summary?: string | null;
	/** The agent message last acted on, so one reply is handled once. */
	handledAt?: string | null;
	pr?: { owner: string; repo: string; number: number } | null;
	ciCheckedAt?: number;
}

/** The card's repositories, reading cards started before multi-repository support too. */
const reposOf = (m: TicketMeta): RepoMeta[] =>
	m.repos ??
	(m.workspaceId
		? [
				{
					workspaceId: m.workspaceId,
					path: '',
					name: '',
					branch: m.branch ?? null,
					base: m.base ?? null,
					pr: m.pr ? { ...m.pr, url: '' } : null
				}
			]
		: []);

export type ReadyWhen = 'draft_pr' | 'ci_green';
const DEFAULT_REPO = '~/.corpus';

export async function conductorSettings(userId: string) {
	const s = await getSettings(userId, ['conductor.repoPath', 'conductor.readyWhen']);
	return {
		repoPath: s['conductor.repoPath'],
		effectiveRepoPath: s['conductor.repoPath'].trim() || DEFAULT_REPO,
		readyWhen: s['conductor.readyWhen'] as ReadyWhen
	};
}

const patchMeta = (cardId: string, patch: Partial<TicketMeta>) =>
	db
		.update(card)
		.set({ meta: sql`${card.meta} || ${JSON.stringify(patch)}::jsonb` })
		.where(eq(card.id, cardId));

const log = (
	userId: string,
	cardId: string | null,
	kind: string,
	text: string,
	actor = 'conductor'
) => db.insert(event).values({ userId, cardId, kind, text: text.slice(0, 2000), actor });

// Background PR work per card, so a slow push never holds the board and never runs twice.
const busy: Set<string> = ((globalThis as { __conductorBusy?: Set<string> }).__conductorBusy ??=
	new Set());
function background(cardId: string, work: () => Promise<void>) {
	if (busy.has(cardId)) return;
	busy.add(cardId);
	void work()
		.catch((e) => console.error('conductor', cardId, e))
		.finally(() => busy.delete(cardId));
}

const MARKER = /^\s*CONDUCTOR:\s*(DONE|BLOCKED)\b[:\s-]*(.*)$/im;

/** Seeds cards for new work, moves reviews along, and returns the board with recent activity. */
export async function board(userId: string) {
	const settings = await conductorSettings(userId);
	const [tickets, reviews] = await Promise.all([
		db
			.select({ id: item.id })
			.from(item)
			.innerJoin(conn, eq(item.connectionId, conn.id))
			.where(
				and(
					eq(conn.userId, userId),
					eq(item.kind, 'issue'),
					inArray(conn.provider, ['linear', 'github']),
					isNull(item.resolvedAt)
				)
			),
		listExternalReviews(userId).catch(() => [] as Review[])
	]);
	const seeds = [
		...tickets.map((t) => ({ userId, itemId: t.id, kind: 'ticket' })),
		...reviews.map((r) => ({ userId, itemId: r.id, kind: 'review' }))
	];
	if (seeds.length) await db.insert(card).values(seeds).onConflictDoNothing();

	const rows = await db
		.select({
			card,
			item: {
				id: item.id,
				title: item.title,
				subtitle: item.subtitle,
				url: item.url,
				state: item.state,
				kind: item.kind,
				updatedAt: item.externalUpdatedAt,
				resolvedAt: item.resolvedAt,
				payload: item.payload
			},
			provider: conn.provider
		})
		.from(card)
		.innerJoin(item, eq(card.itemId, item.id))
		.innerJoin(conn, eq(item.connectionId, conn.id))
		.where(eq(card.userId, userId))
		.orderBy(desc(card.updatedAt));

	const byItem = new Map(reviews.map((r) => [r.id, r]));
	const moves: { id: string; column: Column; text: string }[] = [];
	const cards = rows.flatMap(({ card: c, item: i, provider }) => {
		const r = c.kind === 'review' ? byItem.get(i.id) : undefined;
		let column = c.column as Column;
		// A review only moves forward on its own; the user can still drag it anywhere.
		const derived = c.kind === 'review' ? reviewColumn(r) : null;
		const gone = !!i.resolvedAt && !(c.kind === 'review' && r);
		const next: Column | null = gone ? 'done' : derived;
		if (next && ORDER[next] > ORDER[column]) {
			moves.push({ id: c.id, column: next, text: `Moved to ${LABEL[next]}` });
			column = next;
		}
		const meta = c.meta as TicketMeta;
		let agent: ReturnType<typeof ticketAgent> | null = null;
		if (c.kind === 'ticket' && c.chatId) {
			agent = ticketAgent(userId, c, i, provider, meta, column, settings.readyWhen);
			if (agent.column && ORDER[agent.column] > ORDER[column]) column = agent.column;
		}
		// Done work drops off after a week so the column stays short.
		if (column === 'done' && Date.now() - c.updatedAt.getTime() > 7 * 86_400_000) return [];
		return [
			{
				id: c.id,
				itemId: i.id,
				kind: c.kind as 'ticket' | 'review',
				column,
				provider,
				title: i.title,
				subtitle: i.subtitle,
				url: i.url,
				state: i.state,
				ref: ref(provider, i),
				author: (i.payload as { author?: string } | null)?.author ?? null,
				plannedFor: c.plannedFor,
				chatId: c.chatId,
				prUrl: c.prUrl,
				note: c.note,
				workspaceId: meta.workspaceId ?? null,
				repos: reposOf(meta)
					.map((r) => r.name)
					.filter(Boolean),
				prs: reposOf(meta).flatMap((r) =>
					r.pr?.url ? [{ repo: r.pr.repo, number: r.pr.number, url: r.pr.url }] : []
				),
				blocked: agent?.blocked ?? null,
				summary: agent?.summary ?? meta.summary ?? null,
				agentRunning: agent?.running ?? false,
				/** Its agent thread was removed in Workbench; Start opens a new one. */
				chatGone: !!agent?.gone,
				agentName: agent?.name ?? null,
				opening: busy.has(c.id),
				updatedAt: (i.updatedAt ?? c.updatedAt).toISOString(),
				movedAt: c.updatedAt.toISOString(),
				review: r?.review
					? {
							id: r.review.id,
							status: r.review.status,
							summary: r.review.summary,
							findings: r.review.findings.filter((f) => !(f as { dismissed?: boolean }).dismissed)
								.length,
							postedUrl: r.review.postedUrl,
							approvedUrl: r.review.approvedUrl
						}
					: null
			}
		];
	});

	if (moves.length) {
		await db.transaction(async (tx) => {
			for (const m of moves)
				await tx.update(card).set({ column: m.column }).where(eq(card.id, m.id));
			await tx.insert(event).values(
				moves.map((m) => ({
					userId,
					cardId: m.id,
					kind: 'moved',
					text: m.text,
					actor: 'conductor'
				}))
			);
		});
	}

	const repos = await conductorRepos(settings.effectiveRepoPath).catch(() => []);
	return { cards, activity: await activity(userId), settings, repos };
}

/**
 * Reads the ticket's agent thread and acts on its latest finished reply: `CONDUCTOR: DONE` opens or
 * updates the PR (in the background), `CONDUCTOR: BLOCKED` or any other reply flags the card for you.
 * In `ci_green` mode a ticket with a PR moves to Ready once GitHub's checks pass.
 */
function ticketAgent(
	userId: string,
	c: typeof card.$inferSelect,
	i: { title: string; url: string },
	provider: string,
	meta: TicketMeta,
	column: Column,
	readyWhen: ReadyWhen
) {
	const snap = conductorChat(userId, c.chatId!);
	const out = {
		gone: !!c.chatId && !snap,
		running: !!snap?.running,
		name: snap?.lastAgentName ?? null,
		blocked: meta.blocked ?? null,
		summary: meta.summary ?? null,
		column: null as Column | null
	};
	if (column !== 'working') return out;
	if (!snap) {
		if (meta.blocked !== 'The agent thread was deleted') {
			out.blocked = 'The agent thread was deleted';
			void patchMeta(c.id, { blocked: out.blocked });
		}
		return out;
	}
	if (snap.running) {
		if (meta.blocked) void patchMeta(c.id, { blocked: null });
		out.blocked = null;
		return out;
	}
	if (snap.lastAgentAt && snap.lastAgentAt !== meta.handledAt) {
		const text = snap.lastAgentText ?? '';
		const m = MARKER.exec(text);
		const patch: Partial<TicketMeta> = { handledAt: snap.lastAgentAt };
		if (snap.status === 'failed' || snap.status === 'cancelled') {
			patch.blocked = `Agent ${snap.status}${snap.error ? `: ${snap.error}` : ''}`;
		} else if (m?.[1]?.toUpperCase() === 'DONE') {
			patch.summary = text.replace(MARKER, '').trim().slice(0, 4000) || null;
			patch.blocked = null;
			const ticket = { ...i, ref: ref(provider, i) };
			background(c.id, () =>
				openPr(userId, c.id, { ...meta, ...patch }, ticket, readyWhen).catch(async (e) => {
					const reason = `Couldn't open the PR: ${e instanceof Error ? e.message : String(e)}`;
					await patchMeta(c.id, { blocked: reason });
					await log(userId, c.id, 'blocked', reason);
				})
			);
		} else {
			patch.blocked = m?.[2]?.trim() || 'The agent stopped without finishing. Check the thread.';
			void log(
				userId,
				c.id,
				'blocked',
				`Needs you: ${patch.blocked}`,
				snap.lastAgentName ?? 'agent'
			);
		}
		void patchMeta(c.id, patch);
		Object.assign(out, {
			blocked: patch.blocked ?? out.blocked,
			summary: patch.summary ?? out.summary
		});
		return out;
	}
	const prs = reposOf(meta).flatMap((r) => (r.pr ? [r.pr] : []));
	if (readyWhen === 'ci_green' && prs.length && !meta.blocked && !busy.has(c.id)) {
		if (Date.now() - (meta.ciCheckedAt ?? 0) > 60_000)
			background(c.id, () => checkCi(userId, c.id, prs));
	}
	return out;
}

async function githubToken(userId: string) {
	const [c] = await db
		.select()
		.from(conn)
		.where(and(eq(conn.userId, userId), eq(conn.provider, 'github'), eq(conn.status, 'active')))
		.limit(1);
	if (!c) throw new Error('Connect GitHub in Integrations first');
	return accessToken(c);
}

/**
 * Commits and pushes the agent's work in each repository it changed, then opens a PR there (or just
 * pushes when one exists). Repositories it didn't touch get no PR.
 */
async function openPr(
	userId: string,
	cardId: string,
	meta: TicketMeta,
	ticket: { title: string; url: string; ref: string | null },
	readyWhen: ReadyWhen
) {
	const repos = reposOf(meta).filter((r) => r.branch);
	if (!repos.length)
		throw new Error('The ticket isn’t in a Git worktree, so there is nothing to push');
	const title = ticket.ref ? `${ticket.ref}: ${ticket.title}` : ticket.title;
	const others = (r: RepoMeta) =>
		repos
			.filter((x) => x !== r && x.pr)
			.map((x) => `- ${x.pr!.owner}/${x.pr!.repo}#${x.pr!.number}`);
	let touched = 0;
	for (const r of repos) {
		const pushed = await conductorPush(userId, r.workspaceId, title, r.base);
		if (!pushed.changed) continue;
		touched++;
		if (!pushed.repo) throw new Error(`${r.name || 'origin'} isn’t a GitHub repository`);
		if (r.pr) {
			await log(userId, cardId, 'pushed', `Pushed changes to ${r.pr.repo}#${r.pr.number}`);
			continue;
		}
		const [owner, name] = pushed.repo.split('/') as [string, string];
		const related = others(r);
		const pr = await createPull(
			await githubToken(userId),
			{ owner, repo: name },
			{
				title,
				head: r.branch!,
				base: r.base || 'main',
				body: [
					meta.summary ?? '',
					`Ticket: ${ticket.url}`,
					related.length ? `Related PRs:\n${related.join('\n')}` : '',
					'_Opened by Conductor._'
				]
					.filter(Boolean)
					.join('\n\n'),
				draft: readyWhen === 'draft_pr'
			}
		);
		r.pr = { owner, repo: name, number: pr.number, url: pr.url };
		await patchMeta(cardId, { repos });
		await db
			.update(card)
			.set({ prUrl: repos.find((x) => x.pr)!.pr!.url })
			.where(eq(card.id, cardId));
		await log(
			userId,
			cardId,
			'pr_opened',
			`Opened ${pr.draft ? 'draft ' : ''}PR ${name}#${pr.number}`
		);
	}
	if (!touched) throw new Error('The agent didn’t change anything');
	if (readyWhen === 'draft_pr') {
		await db.update(card).set({ column: 'ready' }).where(eq(card.id, cardId));
		await log(userId, cardId, 'ready', 'Ready for you');
	}
}

/** ci_green: Ready once every PR is out of draft and all their checks passed; flags failures. */
async function checkCi(
	userId: string,
	cardId: string,
	prs: { owner: string; repo: string; number: number }[]
) {
	await patchMeta(cardId, { ciCheckedAt: Date.now() });
	const token = await githubToken(userId);
	let ready = true;
	for (const pr of prs) {
		const d = await pullDetails(token, pr);
		if (d.state !== 'open') continue;
		const failed = d.checks.filter(
			(c) =>
				c.status === 'completed' && !['success', 'neutral', 'skipped'].includes(c.conclusion ?? '')
		);
		if (failed.length) {
			const reason = `CI failed on ${pr.repo}#${pr.number}: ${failed.map((c) => c.name).join(', ')}`;
			await patchMeta(cardId, { blocked: reason });
			await log(userId, cardId, 'blocked', reason);
			return;
		}
		const done = d.checks.length > 0 && d.checks.every((c) => c.status === 'completed');
		if (d.draft || !done) ready = false;
	}
	if (ready) {
		await db.update(card).set({ column: 'ready' }).where(eq(card.id, cardId));
		await log(userId, cardId, 'ready', 'CI passed. Ready for you');
	}
}

const branchSlug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'ticket';

/** Gives a ticket its own worktree and agent thread, seeded with the ticket, and moves it to working. */
export async function startTicket(userId: string, cardId: string, repoPaths: string[] = []) {
	const [row] = await db
		.select({
			card,
			title: item.title,
			url: item.url,
			subtitle: item.subtitle,
			provider: conn.provider
		})
		.from(card)
		.innerJoin(item, eq(card.itemId, item.id))
		.innerJoin(conn, eq(item.connectionId, conn.id))
		.where(and(eq(card.id, cardId), eq(card.userId, userId)))
		.limit(1);
	if (!row) error(404, 'Card not found');
	if (row.card.kind !== 'ticket') error(400, 'Only tickets start agents');
	if (row.card.chatId && conductorChat(userId, row.card.chatId))
		error(409, 'Agents are already on this ticket');
	const { effectiveRepoPath, readyWhen } = await conductorSettings(userId);
	const tref = ref(row.provider, row);
	// The previous thread was removed: open a new one in the same worktrees, keeping branches and PRs.
	const previous = row.card.chatId ? reposOf(row.card.meta as TicketMeta) : [];
	let chosen: string[] = [];
	if (!previous.length) {
		// Only repositories Conductor lists for the configured folder.
		const available = await conductorRepos(effectiveRepoPath);
		chosen = repoPaths.length ? repoPaths : available.length === 1 ? [available[0]!.path] : [];
		const allowed = new Set(available.map((r: { path: string }) => r.path));
		if (!chosen.length) error(400, 'Choose at least one repository');
		if (chosen.some((p) => !allowed.has(p))) error(400, 'Unknown repository');
	}
	const prs = previous.flatMap((r) => (r.pr ? [`${r.pr.repo}#${r.pr.number}`] : []));
	const description = await itemPreview(userId, row.card.itemId)
		.then((p) => p?.body ?? '')
		.catch(() => '');
	const prompt = [
		`Work this ticket${tref ? ` (${tref})` : ''}: ${row.title}`,
		row.url,
		...(description ? ['', 'Description:', description.slice(0, 20000)] : []),
		'',
		'Implement it in this workspace (and the other repositories listed above, if any). Inspect the code',
		'first and keep the change focused.',
		'You can edit files but cannot run shell commands. Conductor commits, pushes and opens the PR',
		`(${readyWhen === 'draft_pr' ? 'as a draft' : 'ready for review'}) once you finish.`,
		...(previous.length
			? [
					'',
					'A previous agent thread on this ticket was removed. Its changes may already be in these',
					`worktrees${prs.length ? ` and in ${prs.join(', ')}` : ''}. Review what is already changed and continue from there.`
				]
			: []),
		'',
		'End your final reply with a short summary of what changed, then a last line that is exactly',
		'`CONDUCTOR: DONE`. If you need a decision from the human instead, end with',
		'`CONDUCTOR: BLOCKED <your question>`.'
	].join('\n');
	let started;
	try {
		started = await conductorStart(userId, {
			repoPaths: chosen,
			workspaceIds: previous.map((r) => r.workspaceId),
			branch: `conductor/${branchSlug(tref ?? row.title)}-${cardId.slice(0, 6)}`,
			title: tref ? `${tref} ${row.title}` : row.title,
			prompt,
			agent: { provider: 'claude', name: 'Builder', role: 'Implements the ticket end to end.' }
		});
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'Couldn’t start agents');
	}
	if (!started.repos) {
		await db
			.update(card)
			.set({ column: 'working', chatId: started.chatId })
			.where(eq(card.id, cardId));
		await patchMeta(cardId, { blocked: null, handledAt: null });
		await log(
			userId,
			cardId,
			'started',
			'Relaunched the conversation in the same worktrees',
			'you'
		);
		return;
	}
	await db
		.update(card)
		.set({
			column: 'working',
			chatId: started.chatId,
			prUrl: null,
			meta: {
				workspaceId: started.repos[0].workspaceId,
				repos: started.repos,
				blocked: null,
				summary: null,
				handledAt: null
			} satisfies TicketMeta
		})
		.where(eq(card.id, cardId));
	await log(
		userId,
		cardId,
		'started',
		`Agents started in ${started.repos.map((r: RepoMeta) => r.name).join(', ')}`,
		'you'
	);
}

/** Sends the note to the ticket's agents (when it has some) and moves it back to Agents working. */
export async function sendBack(userId: string, cardId: string, note: string) {
	const [c] = await db
		.select()
		.from(card)
		.where(and(eq(card.id, cardId), eq(card.userId, userId)))
		.limit(1);
	if (!c) error(404, 'Card not found');
	if (c.chatId && conductorChat(userId, c.chatId))
		conductorSend(
			userId,
			c.chatId,
			`${note}\n\nWhen you're done, end with \`CONDUCTOR: DONE\` again (or \`CONDUCTOR: BLOCKED <question>\`).`
		);
	await db.update(card).set({ column: 'working', note }).where(eq(card.id, cardId));
	await patchMeta(cardId, { blocked: null });
	await log(userId, cardId, 'sent_back', `Sent back: ${note}`, 'you');
}

export const LABEL: Record<Column, string> = {
	inbox: 'Inbox',
	today: 'Today',
	working: 'Agents working',
	ready: 'Ready for you',
	done: 'Done'
};

/** A short id for the card header: ENG-123 for Linear, #42 for GitHub. */
function ref(provider: string, i: { url: string }) {
	if (provider === 'linear') return i.url.match(/\/issue\/([A-Z]+-\d+)/)?.[1] ?? null;
	const n = i.url.match(/\/(?:pull|issues)\/(\d+)/)?.[1];
	return n ? `#${n}` : null;
}

async function activity(userId: string, limit = 30) {
	const rows = await db
		.select({
			id: event.id,
			cardId: event.cardId,
			kind: event.kind,
			text: event.text,
			actor: event.actor,
			at: event.at,
			title: item.title
		})
		.from(event)
		.leftJoin(card, eq(event.cardId, card.id))
		.leftJoin(item, eq(card.itemId, item.id))
		.where(eq(event.userId, userId))
		.orderBy(desc(event.at))
		.limit(limit);
	return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}

async function ownCards(userId: string, ids: string[]) {
	const rows = await db
		.select({ id: card.id, column: card.column })
		.from(card)
		.where(and(eq(card.userId, userId), inArray(card.id, ids)));
	if (rows.length !== new Set(ids).size) error(404, 'Card not found');
	return rows;
}

/** Moves one card. Records who did it so the rail reads as a timeline. */
export async function moveCard(userId: string, cardId: string, column: Column) {
	const [c] = await ownCards(userId, [cardId]);
	if (c!.column === column) return;
	await db.update(card).set({ column }).where(eq(card.id, cardId));
	await log(
		userId,
		cardId,
		column === 'done' ? 'shipped' : 'moved',
		`Moved to ${LABEL[column]}`,
		'you'
	);
}

/**
 * Confirms today's plan: the picked cards go to Today (tickets already further along stay put), and
 * Today cards that weren't picked go back to the Inbox.
 */
export async function confirmPlan(userId: string, tz: string, cardIds: string[]) {
	const day = localDay(tz);
	if (cardIds.length) await ownCards(userId, cardIds);
	await db.transaction(async (tx) => {
		await tx
			.update(card)
			.set({ column: 'inbox', plannedFor: null })
			.where(
				and(
					eq(card.userId, userId),
					eq(card.column, 'today'),
					cardIds.length ? notInArray(card.id, cardIds) : undefined
				)
			);
		if (cardIds.length)
			await tx
				.update(card)
				.set({ column: 'today', plannedFor: day })
				.where(
					and(
						eq(card.userId, userId),
						inArray(card.id, cardIds),
						inArray(card.column, ['inbox', 'today'])
					)
				);
		await tx.insert(event).values({
			userId,
			kind: 'plan_confirmed',
			text: `Daily plan: ${cardIds.length} ${cardIds.length === 1 ? 'item' : 'items'} for today`
		});
	});
}
