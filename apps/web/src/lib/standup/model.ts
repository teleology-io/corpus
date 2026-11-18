// Standup: evidence types, the deterministic renderer, the model prompt and its validator.
// Shared by server and client. Every fact in the rendered Markdown comes from evidence fields;
// a model only chooses the order of items and which pre-written statements to show.

export type Detail = 'compact' | 'verbose';
export type Section = 'past' | 'today';

/** Fixed wording per kind of observed activity. Never inferred beyond what the source shows. */
export const VERBS = {
	completed_task: 'Completed task',
	committed: 'Committed changes',
	opened_pr: 'Opened PR',
	pr_merged: 'PR merged',
	pr_closed: 'PR closed',
	pr_no_longer_open: 'PR no longer open',
	pr_open: 'PR open',
	review_requested: 'Review requested',
	reviewed_pr: 'Reviewed PR',
	review_unverified: 'Review posted (authorship unverified)',
	review_ran: 'Integration Review ran',
	issue_completed: 'Issue completed',
	issue_closed: 'Issue closed',
	issue_canceled: 'Issue canceled',
	issue_assigned: 'Issue due',
	thread_activity: 'Worked in thread',
	task_todo: 'To do',
	task_overdue: 'Overdue',
	event: 'Meeting'
} as const;
export type Verb = keyof typeof VERBS;

export interface StandupLink {
	label: string;
	url: string;
}
export interface Statement {
	key: string;
	text: string;
}
/**
 * Descriptors only: nothing executes these while generating a standup. A later "start today's
 * work" flow can act on them without parsing Markdown.
 */
export type StandupAction =
	| { type: 'open'; href: string }
	| { type: 'start_thread'; workspaceId: string; prompt: string }
	| { type: 'start_review'; itemId: string };

export interface StandupItem {
	id: string;
	section: Section;
	verb: Verb;
	/** Overrides the verb label in the rendered line, e.g. "4:30 PM" for a meeting. */
	lead?: string;
	title: string;
	url: string | null;
	/** Source timestamp of the activity (ISO), when there is one. */
	at: string | null;
	project?: string | null;
	source: { type: string; id: string };
	/** Other evidence folded into this item by an exact relationship (e.g. the thread that pushed the PR). */
	related: StandupLink[];
	statements: Statement[];
	actions: StandupAction[];
	/**
	 * Today only. `auto` is always included; otherwise it's a checklist candidate the
	 * user picks before generating, checked (`on`) or unchecked (`off`) by default.
	 */
	plan?: 'auto' | 'on' | 'off';
	/** Today only: checklist grouping. Reviews of others' work stay apart from the user's own. */
	group?: PlanGroup;
}

export type PlanGroup = 'meeting' | 'pr' | 'review' | 'ticket' | 'task';
export const PLAN_GROUPS: { key: PlanGroup; label: string }[] = [
	{ key: 'meeting', label: 'Meetings' },
	{ key: 'pr', label: 'Your open PRs' },
	{ key: 'review', label: 'Reviews requested from you' },
	{ key: 'ticket', label: 'Assigned tickets' },
	{ key: 'task', label: 'Tasks' }
];

/** Ids checked by default: every `on` candidate. */
export function defaultSelection(snapshot: StandupSnapshot): string[] {
	return snapshot.items.filter((i) => i.section === 'today' && i.plan === 'on').map((i) => i.id);
}

/**
 * The snapshot the standup is written from: past items as collected, Today limited to automatic
 * items plus the user's picks. Runs identically in the browser and on the server (hosted), so
 * both validate against the same item set. Unknown ids are ignored.
 */
export function selectToday(
	snapshot: StandupSnapshot,
	selected: readonly string[]
): StandupSnapshot {
	const picked = new Set(selected);
	return {
		...snapshot,
		items: snapshot.items.filter(
			(i) => i.section !== 'today' || i.plan === 'auto' || i.plan === undefined || picked.has(i.id)
		)
	};
}

export interface Coverage {
	source: string;
	label: string;
	status: 'included' | 'not_connected' | 'unavailable';
	note?: string;
}

export interface StandupSnapshot {
	v: 1;
	id: string;
	userId: string;
	createdAt: string;
	expiresAt: string;
	timezone: string;
	window: { label: 'Yesterday' | 'Last week'; from: string; to: string };
	items: StandupItem[];
	coverage: Coverage[];
}

export interface PlanEntry {
	id: string;
	statements: string[];
}
export interface StandupPlan {
	past: PlanEntry[];
	today: PlanEntry[];
}

/** Items shown before "+N more" in the sheet. Copied Markdown always has everything. */
export const VISIBLE_PER_SECTION = 6;
/** Verbose shows at most this many statements per item. */
export const MAX_STATEMENTS = 3;

const SECTIONS: Section[] = ['past', 'today'];

/** Collector order, every statement in verbose (capped), none in compact. */
export function defaultPlan(snapshot: StandupSnapshot, detail: Detail): StandupPlan {
	const plan: StandupPlan = { past: [], today: [] };
	for (const item of snapshot.items)
		plan[item.section].push({
			id: item.id,
			statements:
				detail === 'verbose' ? item.statements.slice(0, MAX_STATEMENTS).map((s) => s.key) : []
		});
	return plan;
}

const escapeText = (s: string) =>
	s
		.replace(/([\\[\]])/g, '\\$1')
		.replace(/\s+/g, ' ')
		.trim();
const URL_ESCAPES: Record<string, string> = {
	'(': '%28',
	')': '%29',
	' ': '%20',
	'<': '%3C',
	'>': '%3E'
};
const escapeUrl = (u: string) =>
	u.replace(/[()<>\s]/g, (c) => URL_ESCAPES[c] ?? encodeURIComponent(c));
const link = (label: string, url: string | null) =>
	url ? `[${escapeText(label)}](${escapeUrl(url)})` : escapeText(label);

export function renderLine(item: StandupItem, statementKeys: string[]): string {
	const lead = item.lead ?? VERBS[item.verb];
	let line = `- ${lead}: ${link(item.title, item.url)}`;
	if (item.related.length) line += ` (${item.related.map((r) => link(r.label, r.url)).join(', ')})`;
	const notes = statementKeys
		.map((k) => item.statements.find((s) => s.key === k)?.text)
		.filter((t): t is string => !!t)
		.map(escapeText);
	if (notes.length) line += ` — ${notes.join('; ')}`;
	return line;
}

/** Work on someone else's PR (reviewing it, or being asked to). Never mixed into the user's own. */
export const REVIEW_VERBS: ReadonlySet<Verb> = new Set([
	'reviewed_pr',
	'review_unverified',
	'review_ran',
	'review_requested'
]);

/**
 * Stable split: the user's own work first, then reviews of others' work, in each section. Keeps
 * the model's order within each group, so a model can't interleave the two.
 */
export function separateReviews(snapshot: StandupSnapshot, plan: StandupPlan): StandupPlan {
	const byId = new Map(snapshot.items.map((i) => [i.id, i]));
	const isReview = (e: PlanEntry) => REVIEW_VERBS.has(byId.get(e.id)!.verb);
	const split = (list: PlanEntry[]) => [
		...list.filter((e) => !isReview(e)),
		...list.filter(isReview)
	];
	return { past: split(plan.past), today: split(plan.today) };
}

export interface RenderedSection {
	section: Section;
	heading: string;
	lines: string[];
}

export function renderSections(snapshot: StandupSnapshot, plan: StandupPlan): RenderedSection[] {
	const byId = new Map(snapshot.items.map((i) => [i.id, i]));
	return SECTIONS.map((section) => ({
		section,
		heading: section === 'past' ? snapshot.window.label : 'Today',
		lines: plan[section].map((e) => renderLine(byId.get(e.id)!, e.statements))
	}));
}

/** The complete standup. Never truncated: collapsing is a display concern only. */
export function renderMarkdown(snapshot: StandupSnapshot, plan: StandupPlan): string {
	return renderSections(snapshot, plan)
		.map((s) => `## ${s.heading}\n${s.lines.length ? s.lines.join('\n') : '- Nothing recorded'}`)
		.join('\n\n');
}

// ---------- model prompt ----------

export function standupMessages(snapshot: StandupSnapshot, detail: Detail) {
	const items = snapshot.items.map((i) => ({
		id: i.id,
		section: i.section,
		what: i.lead ?? VERBS[i.verb],
		title: i.title,
		...(i.project ? { project: i.project } : {}),
		...(detail === 'verbose' && i.statements.length
			? { statements: Object.fromEntries(i.statements.map((s) => [s.key, s.text])) }
			: {})
	}));
	const rules =
		detail === 'verbose'
			? `Detail: verbose. For each item, pick up to ${MAX_STATEMENTS} statement keys from that item's own "statements" that best explain outcomes, pending reviews and next steps. Use [] when none apply. Use only keys listed on that item.`
			: 'Detail: compact. Every "statements" array must be [].';
	const system = `You order the items of a daily standup. You do not write any text.
Reply with one JSON object only, no prose and no code fences:
{"past":[{"id":"e1","statements":[]}],"today":[{"id":"e2","statements":[]}]}
Rules:
- Include every item id exactly once, in the section given by its "section" field.
- Order each section by importance: shipped or merged work first, then reviews, then work in progress, then meetings and routine tasks.
- ${rules}`;
	const user = `Items:\n${JSON.stringify(items)}`;
	return {
		messages: [
			{ role: 'system' as const, content: system },
			{ role: 'user' as const, content: user }
		],
		maxNewTokens: Math.min(2000, 80 + snapshot.items.length * (detail === 'verbose' ? 28 : 14))
	};
}

// ---------- validation ----------

export type Validation = { ok: true; plan: StandupPlan } | { ok: false; errors: string[] };

function extractJson(raw: string): unknown {
	const text = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '');
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) throw new Error('no JSON object');
	return JSON.parse(text.slice(start, end + 1));
}

/**
 * Pass/fail: any problem rejects the whole output (the caller falls back), nothing is dropped
 * line by line. Facts can't be wrong because the model only returns ids and statement keys that
 * must belong to the cited item; this checks that and that nothing was left out.
 */
export function validatePlan(snapshot: StandupSnapshot, raw: string, detail: Detail): Validation {
	let data: unknown;
	try {
		data = extractJson(raw);
	} catch {
		return { ok: false, errors: ['Output is not valid JSON'] };
	}
	if (!data || typeof data !== 'object') return { ok: false, errors: ['Output is not an object'] };
	const errors: string[] = [];
	const byId = new Map(snapshot.items.map((i) => [i.id, i]));
	const seen = new Set<string>();
	const plan: StandupPlan = { past: [], today: [] };
	for (const section of SECTIONS) {
		const list = (data as Record<string, unknown>)[section];
		if (!Array.isArray(list)) {
			errors.push(`"${section}" is missing or not a list`);
			continue;
		}
		for (const entry of list) {
			const e = entry as { id?: unknown; statements?: unknown };
			if (!e || typeof e !== 'object' || typeof e.id !== 'string') {
				errors.push(`Malformed entry in ${section}`);
				continue;
			}
			const item = byId.get(e.id);
			if (!item) {
				errors.push(`Unknown id ${e.id}`);
				continue;
			}
			if (item.section !== section)
				errors.push(`${e.id} is in ${section}, expected ${item.section}`);
			if (seen.has(e.id)) errors.push(`${e.id} appears more than once`);
			seen.add(e.id);
			const keys = e.statements ?? [];
			if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
				errors.push(`${e.id} statements must be a list of keys`);
				continue;
			}
			if (detail === 'compact' && keys.length)
				errors.push(`${e.id} has statements in compact mode`);
			if (keys.length > MAX_STATEMENTS)
				errors.push(`${e.id} has more than ${MAX_STATEMENTS} statements`);
			for (const k of keys as string[])
				if (!item.statements.some((s) => s.key === k))
					errors.push(`${e.id} cites statement "${k}" it doesn't have`);
			if (new Set(keys).size !== keys.length) errors.push(`${e.id} repeats a statement`);
			plan[section].push({ id: e.id, statements: keys as string[] });
		}
	}
	for (const item of snapshot.items) if (!seen.has(item.id)) errors.push(`${item.id} is missing`);
	return errors.length ? { ok: false, errors } : { ok: true, plan };
}

// ---------- provider selection ----------

export type ProviderPref = 'auto' | 'liquid' | 'hosted';
export type GeneratedBy = 'liquid' | 'hosted' | 'template';

export interface StandupResult {
	markdown: string;
	plan: StandupPlan;
	detail: Detail;
	by: GeneratedBy;
	/** Shown in the footer: which provider, and why any fallback happened. */
	note: string;
	/** Every provider tried, in order, with the exact reason. Shown under "Details". */
	attempts: GenerationAttempt[];
}

export interface GenerationAttempt {
	provider: 'liquid' | 'hosted' | 'template';
	outcome: 'used' | 'unavailable' | 'invalid' | 'error' | 'skipped';
	reason: string;
	/** All validation errors, not just the first. */
	errors?: string[];
	ms?: number;
	/** The start of what the model returned, when it failed validation. */
	output?: string;
	/** Device facts behind a Liquid decision. */
	checks?: Record<string, boolean | string>;
}

/**
 * What to try after Liquid didn't produce a valid plan. `reason` distinguishes "unavailable"
 * from "poor output" for the footer; the decision itself only depends on the preference and access.
 */
export function nextAfterLiquid(pref: ProviderPref, hostedAllowed: boolean): 'hosted' | 'template' {
	return pref !== 'liquid' && hostedAllowed ? 'hosted' : 'template';
}
