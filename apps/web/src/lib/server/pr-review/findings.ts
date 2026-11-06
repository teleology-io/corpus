// Pure rules for reviewer output. Anything that can't be proven complete must never read as clean.

export const SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type ReviewerRole = 'integrator' | 'breaker';

export interface Finding {
	id: string;
	severity: Severity;
	category: string;
	file: string;
	line: number | null;
	title: string;
	trigger: string;
	impact: string;
	evidence: string[];
	fix: string;
	reviewer: ReviewerRole;
	disputed?: boolean;
	dropped?: { evidence: string[] };
	outcome?: 'open' | 'dismissed' | 'posted' | 'addressed';
}

export interface ReviewerResult {
	verdict: 'clean' | 'findings';
	notReviewed: { path: string; reason: string }[];
	findings: Finding[];
	questions: string[];
}

export interface CrosscheckResult {
	id: string;
	status: 'confirmed' | 'refuted';
	uncertain: boolean;
	evidence: string[];
}

export type ReviewStatus =
	'queued' | 'running' | 'clean' | 'findings' | 'partial' | 'failed' | 'interrupted' | 'stale';

const asText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const asTexts = (value: unknown) => (Array.isArray(value) ? value.map(asText).filter(Boolean) : []);

/** The JSON in the last fenced block with this tag, or null when there is none or it's invalid. */
function lastBlock(text: string, tag: string): unknown {
	const blocks = [...text.matchAll(new RegExp('```' + tag + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g'))];
	const last = blocks.at(-1);
	if (!last) return null;
	try {
		return JSON.parse(last[1]);
	} catch {
		return null;
	}
}

/** Reviewer output, or null when it can't be trusted. A null must not become a clean review. */
export function parseReview(text: string, reviewer: ReviewerRole): ReviewerResult | null {
	const raw = lastBlock(text, 'review-findings') as Record<string, unknown> | null;
	if (!raw || typeof raw !== 'object') return null;
	if (raw.verdict !== 'clean' && raw.verdict !== 'findings') return null;
	if (!Array.isArray(raw.findings)) return null;

	const findings: Finding[] = [];
	for (const entry of raw.findings as Record<string, unknown>[]) {
		const severity = entry?.severity as Severity;
		const title = asText(entry?.title);
		// A malformed finding fails the whole result rather than silently vanishing.
		if (!SEVERITIES.includes(severity) || !title || !asText(entry?.id)) return null;
		findings.push({
			id: `${reviewer}:${asText(entry.id)}`,
			severity,
			category: asText(entry.category) || 'correctness',
			file: asText(entry.file),
			line:
				Number.isInteger(entry.line) && (entry.line as number) > 0 ? (entry.line as number) : null,
			title,
			trigger: asText(entry.trigger),
			impact: asText(entry.impact),
			evidence: asTexts(entry.evidence),
			fix: asText(entry.fix),
			reviewer,
			outcome: 'open'
		});
	}
	// Claiming clean while listing findings is contradictory, so don't pick a side.
	if (raw.verdict === 'clean' && findings.length) return null;

	const coverage = raw.coverage as { not_reviewed?: { path?: unknown; reason?: unknown }[] } | null;
	const notReviewed = Array.isArray(coverage?.not_reviewed)
		? coverage.not_reviewed.map((n) => ({ path: asText(n?.path), reason: asText(n?.reason) }))
		: [];
	return { verdict: raw.verdict, notReviewed, findings, questions: asTexts(raw.questions) };
}

export function parseCrosscheck(text: string): CrosscheckResult[] | null {
	const raw = lastBlock(text, 'review-crosscheck') as { results?: unknown } | null;
	if (!raw || !Array.isArray(raw.results)) return null;
	return (raw.results as Record<string, unknown>[]).map((r) => ({
		id: asText(r?.id),
		status: r?.status === 'refuted' ? 'refuted' : 'confirmed',
		uncertain: r?.uncertain === true,
		evidence: asTexts(r?.evidence)
	}));
}

/**
 * A blocker drops only on a refutation that cites evidence. Everything else stays, and uncertainty
 * or a missing answer marks it disputed. Dropped findings are kept and flagged so they stay visible.
 */
export function applyCrosscheck(
	findings: Finding[],
	results: CrosscheckResult[] | null
): Finding[] {
	return findings.map((finding) => {
		if (finding.severity !== 'blocker') return finding;
		const result = results?.find((r) => r.id === finding.id);
		if (!result) return { ...finding, disputed: true };
		if (result.status === 'refuted' && result.evidence.length)
			return { ...finding, dropped: { evidence: result.evidence } };
		if (result.status === 'refuted' || result.uncertain) return { ...finding, disputed: true };
		return finding;
	});
}

export const liveFindings = (findings: Finding[]) => findings.filter((f) => !f.dropped);
export const liveBlockers = (findings: Finding[]) =>
	liveFindings(findings).filter((f) => f.severity === 'blocker');

/**
 * Clean needs both reviewers to have finished, reviewed everything, and found nothing still standing.
 * Findings on a partial review still report as partial, so the missing coverage can't be overlooked.
 */
export function finalStatus(input: {
	results: (ReviewerResult | null)[];
	partial: boolean;
	findings: Finding[];
}): ReviewStatus {
	if (input.results.length !== 2 || input.results.some((r) => !r)) return 'failed';
	const skipped = input.results.some((r) => r!.notReviewed.length > 0);
	if (input.partial || skipped) return 'partial';
	return liveFindings(input.findings).length ? 'findings' : 'clean';
}
