// Pure: raw evidence → standup items. No I/O, so selection and wording are unit-tested directly.
import type { OccurrenceDTO, TaskDTO, WorkbenchTaskDTO } from '#lib/types.js';
import type {
	Coverage,
	Section,
	Statement,
	StandupAction,
	StandupItem,
	Verb
} from '#lib/standup/model.js';

export interface WindowBounds {
	label: 'Yesterday' | 'Last week';
	from: Date;
	to: Date;
	todayEnd: Date;
}
export interface ThreadActivity {
	id: string;
	title: string;
	workspaceId: string;
	workspace: string | null;
	project: string | null;
	url: string;
	turns: number;
	failed: number;
	lastStatus: string | null;
	lastAt: string;
	prUrls: string[];
}
export interface CommitActivity {
	sha: string;
	at: string;
	subject: string;
	workspaceId: string;
	branch: string;
	workspace: string | null;
	project: string | null;
	url: string | null;
	workspaceUrl: string;
}
export interface IntegrationRow {
	id: string;
	provider: string;
	kind: string;
	title: string;
	subtitle: string | null;
	url: string;
	state: string | null;
	payload: Record<string, unknown> | null;
	resolvedAt: string | null;
}
export interface ReviewRow {
	id: string;
	itemId: string;
	title: string;
	subtitle: string | null;
	url: string;
	status: string;
	postedUrl: string | null;
	postedBy: string | null;
	accountLogin: string | null;
	findings: number;
	updatedAt: string;
}
export interface RawEvidence {
	tz: string;
	window: WindowBounds;
	tasksDone: TaskDTO[];
	tasksOpen: TaskDTO[];
	events: OccurrenceDTO[];
	workbench: {
		threads: ThreadActivity[];
		commits: CommitActivity[];
		tasks: WorkbenchTaskDTO[];
	} | null;
	items: IntegrationRow[];
	reviews: ReviewRow[];
	coverage: Coverage[];
}

/** Keeps the signed snapshot small; anything beyond is reported in coverage, never dropped silently. */
export const MAX_ITEMS_PER_SECTION = 80;

type Draft = Omit<StandupItem, 'id'>;

const within = (iso: string | null | undefined, from: Date, to: Date) => {
	if (!iso) return false;
	const t = Date.parse(iso);
	return t >= from.getTime() && t < to.getTime();
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function draft(
	section: Section,
	verb: Verb,
	title: string,
	url: string | null,
	source: { type: string; id: string },
	extra: Partial<Draft> = {}
): Draft {
	const actions: StandupAction[] = url ? [{ type: 'open', href: url }] : [];
	return {
		section,
		verb,
		title,
		url,
		at: null,
		source,
		related: [],
		statements: [],
		...extra,
		actions: [...actions, ...(extra.actions ?? [])]
	};
}

const PR_STATE: Record<string, Statement> = {
	draft: { key: 'draft', text: 'draft' },
	review_required: { key: 'review', text: 'awaiting review' },
	changes_requested: { key: 'review', text: 'changes requested' },
	approved: { key: 'review', text: 'approved' },
	failure: { key: 'checks', text: 'checks failing' },
	error: { key: 'checks', text: 'checks failing' },
	pending: { key: 'checks', text: 'checks running' },
	expected: { key: 'checks', text: 'checks running' },
	success: { key: 'checks', text: 'checks passing' }
};

/** "draft · changes_requested · failure" → field-derived statements. */
export function prStatements(state: string | null, subtitle: string | null): Statement[] {
	const out: Statement[] = [];
	for (const part of (state ?? '').split(' · ')) {
		const s = PR_STATE[part.trim()];
		if (s && !out.some((o) => o.key === s.key)) out.push(s);
	}
	if (subtitle) out.push({ key: 'ref', text: subtitle });
	return out;
}

function timeLabel(iso: string, tz: string) {
	return new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: tz
	}).format(new Date(iso));
}

export function buildItems(raw: RawEvidence): { items: StandupItem[]; coverage: Coverage[] } {
	const { from, to, todayEnd } = raw.window;
	const past: Draft[] = [];
	const today: Draft[] = [];

	// ----- pull requests, reviews, issues -----
	const merged: Draft[] = [];
	const opened: Draft[] = [];
	const reviews: Draft[] = [];
	const issuesDone: Draft[] = [];
	const prsOpen: Draft[] = [];
	const reviewRequests: Draft[] = [];
	const issuesOpen: Draft[] = [];
	for (const i of raw.items) {
		const source = { type: `${i.provider}:${i.kind}`, id: i.id };
		const p = i.payload ?? {};
		const outcome = str(p.outcome);
		const outcomeAt = str(p.outcomeAt);
		if (i.kind === 'pull_request') {
			if (i.resolvedAt) {
				const ref = i.subtitle ? [{ key: 'ref', text: i.subtitle }] : [];
				if (outcome === 'merged' && within(outcomeAt, from, to))
					merged.push(
						draft('past', 'pr_merged', i.title, i.url, source, { at: outcomeAt, statements: ref })
					);
				else if (outcome === 'closed' && within(outcomeAt, from, to))
					merged.push(
						draft('past', 'pr_closed', i.title, i.url, source, { at: outcomeAt, statements: ref })
					);
				// Without a provider outcome we only know it left the open list.
				else if (!outcome && within(i.resolvedAt, from, to))
					merged.push(
						draft('past', 'pr_no_longer_open', i.title, i.url, source, {
							at: i.resolvedAt,
							statements: ref
						})
					);
				continue;
			}
			const createdAt = str(p.createdAt);
			const statements = prStatements(i.state, i.subtitle);
			// "Opened" needs GitHub's creation time inside the window; otherwise it's just open.
			if (within(createdAt, from, to))
				opened.push(
					draft('past', 'opened_pr', i.title, i.url, source, { at: createdAt, statements })
				);
			else prsOpen.push(draft('today', 'pr_open', i.title, i.url, source, { statements }));
		} else if (i.kind === 'review_request') {
			if (i.resolvedAt) continue;
			reviewRequests.push(
				draft('today', 'review_requested', i.title, i.url, source, {
					statements: prStatements(i.state, i.subtitle),
					actions: [{ type: 'start_review', itemId: i.id }]
				})
			);
		} else if (i.kind === 'issue') {
			const ref = i.subtitle ? [{ key: 'ref', text: i.subtitle }] : [];
			if (i.resolvedAt) {
				const verb: Verb | null =
					outcome === 'completed'
						? 'issue_completed'
						: outcome === 'canceled'
							? 'issue_canceled'
							: outcome === 'closed'
								? 'issue_closed'
								: null;
				if (verb && within(outcomeAt, from, to))
					issuesDone.push(
						draft('past', verb, i.title, i.url, source, { at: outcomeAt, statements: ref })
					);
				continue;
			}
			const statements = [...ref];
			if (i.state) statements.push({ key: 'state', text: i.state });
			const due = str(p.dueDate);
			if (due) statements.push({ key: 'due', text: `due ${due}` });
			issuesOpen.push(draft('today', 'issue_assigned', i.title, i.url, source, { statements }));
		}
	}
	// Changes requested / failing first: that's what needs action today.
	const urgency = (d: Draft) =>
		d.statements.some((s) => s.text === 'changes requested' || s.text === 'checks failing') ? 0 : 1;
	prsOpen.sort((a, b) => urgency(a) - urgency(b));

	for (const r of raw.reviews) {
		if (!within(r.updatedAt, from, to)) continue;
		if (!['clean', 'findings', 'partial'].includes(r.status)) continue;
		const verified =
			!!r.postedUrl &&
			!!r.postedBy &&
			!!r.accountLogin &&
			r.postedBy.toLowerCase() === r.accountLogin.toLowerCase();
		const verb: Verb = r.postedUrl
			? verified
				? 'reviewed_pr'
				: 'review_unverified'
			: 'review_ran';
		const statements: Statement[] = [];
		statements.push({
			key: 'findings',
			text: r.findings ? `${r.findings} finding${r.findings === 1 ? '' : 's'}` : 'no findings'
		});
		if (r.status === 'partial')
			statements.push({ key: 'partial', text: 'some reviewers did not finish' });
		if (r.subtitle) statements.push({ key: 'ref', text: r.subtitle });
		reviews.push(
			draft(
				'past',
				verb,
				r.title,
				r.postedUrl ?? r.url,
				{ type: 'pr_review', id: r.id },
				{
					at: r.updatedAt,
					statements,
					related: r.postedUrl ? [{ label: 'PR', url: r.url }] : []
				}
			)
		);
	}

	// ----- tasks -----
	const tasksDone: Draft[] = [];
	for (const t of raw.tasksDone)
		if (within(t.completedAt, from, to))
			tasksDone.push(
				draft(
					'past',
					'completed_task',
					t.title,
					t.externalUrl,
					{ type: 'task', id: t.id },
					{ at: t.completedAt }
				)
			);
	const tasksToday: Draft[] = [];
	for (const t of raw.tasksOpen) {
		if (t.completedAt) continue;
		const overdue = !!t.dueAt && Date.parse(t.dueAt) < to.getTime();
		const statements: Statement[] = [];
		if (t.dueAt && !overdue && !t.dueAllDay)
			statements.push({ key: 'due', text: `due ${timeLabel(t.dueAt, raw.tz)}` });
		if (t.priority >= 3) statements.push({ key: 'priority', text: 'high priority' });
		tasksToday.push(
			draft(
				'today',
				overdue ? 'task_overdue' : 'task_todo',
				t.title,
				t.externalUrl,
				{ type: 'task', id: t.id },
				{
					statements
				}
			)
		);
	}
	const workbenchToday: Draft[] = [];
	for (const t of raw.workbench?.tasks ?? []) {
		const url = `/workbench?${new URLSearchParams({ workspace: t.workspaceId, tab: 'tasks' })}`;
		const project = [t.project, t.workspace].filter(Boolean).join(' / ') || null;
		const statements: Statement[] = project ? [{ key: 'project', text: project }] : [];
		if (t.status === 'done') {
			if (within(t.completedAt, from, to))
				tasksDone.push(
					draft(
						'past',
						'completed_task',
						t.title,
						url,
						{ type: 'workbench_task', id: t.id },
						{
							at: t.completedAt,
							project: t.project,
							statements
						}
					)
				);
			continue;
		}
		if (t.status === 'doing') statements.unshift({ key: 'status', text: 'in progress' });
		workbenchToday.push(
			draft(
				'today',
				'task_todo',
				t.title,
				url,
				{ type: 'workbench_task', id: t.id },
				{
					project: t.project,
					statements,
					actions: [{ type: 'start_thread', workspaceId: t.workspaceId, prompt: t.title }]
				}
			)
		);
	}

	// ----- commits: one item per repository branch -----
	const commitGroups = new Map<string, CommitActivity[]>();
	for (const c of raw.workbench?.commits ?? []) {
		const key = `${c.workspaceId}`;
		commitGroups.set(key, [...(commitGroups.get(key) ?? []), c]);
	}
	const commits: Draft[] = [];
	for (const group of commitGroups.values()) {
		const sorted = [...group].sort((a, b) => b.at.localeCompare(a.at));
		const first = sorted[0]!;
		const title = [first.project, first.branch].filter(Boolean).join(' · ');
		const statements: Statement[] = [
			{ key: 'count', text: `${group.length} commit${group.length === 1 ? '' : 's'}` },
			...sorted.slice(0, 2).map((c, n) => ({ key: `c${n + 1}`, text: `“${c.subject}”` }))
		];
		commits.push(
			draft(
				'past',
				'committed',
				title,
				first.workspaceUrl,
				{ type: 'commits', id: first.workspaceId },
				{
					at: first.at,
					project: first.project,
					statements
				}
			)
		);
	}

	// ----- threads: folded into a PR only when they cite that PR's exact URL -----
	const prByUrl = new Map<string, Draft>();
	for (const d of [...merged, ...opened]) if (d.url) prByUrl.set(d.url, d);
	const threads: Draft[] = [];
	for (const t of raw.workbench?.threads ?? []) {
		const prs = t.prUrls.map((u) => prByUrl.get(u)).filter((d): d is Draft => !!d);
		if (prs.length) {
			for (const pr of prs) pr.related.push({ label: 'thread', url: t.url });
			continue;
		}
		const statements: Statement[] = [
			{ key: 'turns', text: `${t.turns} agent turn${t.turns === 1 ? '' : 's'}` }
		];
		if (t.lastStatus === 'running') statements.unshift({ key: 'status', text: 'still running' });
		else if (t.lastStatus === 'failed')
			statements.unshift({ key: 'status', text: 'last turn failed' });
		else if (t.lastStatus === 'interrupted')
			statements.unshift({ key: 'status', text: 'last turn interrupted' });
		const project = [t.project, t.workspace].filter(Boolean).join(' / ');
		if (project) statements.push({ key: 'project', text: project });
		threads.push(
			draft(
				'past',
				'thread_activity',
				t.title,
				t.url,
				{ type: 'thread', id: t.id },
				{
					at: t.lastAt,
					project: t.project,
					statements
				}
			)
		);
	}

	// ----- today's calendar -----
	const events: Draft[] = [...raw.events]
		.filter((e) => Date.parse(e.end) > to.getTime() && Date.parse(e.start) < todayEnd.getTime())
		.sort((a, b) => +b.allDay - +a.allDay || a.start.localeCompare(b.start))
		.map((e) => {
			const statements: Statement[] = [];
			if (!e.allDay) statements.push({ key: 'until', text: `until ${timeLabel(e.end, raw.tz)}` });
			if (e.location) statements.push({ key: 'location', text: e.location });
			const date = new Intl.DateTimeFormat('en-CA', { timeZone: raw.tz }).format(new Date(e.start));
			return draft(
				'today',
				'event',
				e.title,
				`/calendar?${new URLSearchParams({ date, event: e.eventId })}`,
				{ type: 'event', id: e.key },
				{ lead: e.allDay ? 'All day' : timeLabel(e.start, raw.tz), at: e.start, statements }
			);
		});

	past.push(...merged, ...opened, ...reviews, ...issuesDone, ...tasksDone, ...commits, ...threads);
	today.push(
		...events,
		...prsOpen,
		...reviewRequests,
		...tasksToday,
		...workbenchToday,
		...issuesOpen
	);

	// Exact same URL twice in a section (e.g. two review runs of one PR): keep the first.
	const dedupe = (list: Draft[]) => {
		const seen = new Set<string>();
		return list.filter((d) => {
			if (!d.url) return true;
			if (seen.has(d.url)) return false;
			seen.add(d.url);
			return true;
		});
	};
	const coverage = [...raw.coverage];
	const cap = (list: Draft[], label: string) => {
		if (list.length <= MAX_ITEMS_PER_SECTION) return list;
		coverage.push({
			source: 'limit',
			label,
			status: 'unavailable',
			note: `${list.length - MAX_ITEMS_PER_SECTION} more items not included`
		});
		return list.slice(0, MAX_ITEMS_PER_SECTION);
	};
	const ordered = [...cap(dedupe(past), raw.window.label), ...cap(dedupe(today), 'Today')];
	return { items: ordered.map((d, n) => ({ id: `e${n + 1}`, ...d })), coverage };
}
