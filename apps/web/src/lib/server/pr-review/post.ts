// Turns stored findings into the GitHub review you preview and post.
import { commentableLines, type ReviewComment } from '@corpus/core/integrations';
import type { Finding } from './findings';

// Reviewer text is shaped by hostile PRs, so it must not be able to ping anyone under your name.
const quiet = (text: string) => text.replace(/@(?=[\w-])/g, '@​');

function renderFinding(f: Finding) {
	return quiet(
		[
			`**${f.severity}${f.disputed ? ' (disputed)' : ''}: ${f.title}**`,
			f.trigger && `Trigger: ${f.trigger}`,
			f.impact && `Impact: ${f.impact}`,
			f.fix && `Fix: ${f.fix}`
		]
			.filter(Boolean)
			.join('\n\n')
	);
}

/**
 * Dropped and dismissed findings stay out. Everything else is posted: findings GitHub can't anchor
 * to a diff line go in the review body, because a rejected or skipped comment would lose them.
 */
export function buildGithubReview(findings: Finding[], patch: string) {
	const lines = commentableLines(patch);
	const live = findings.filter((f) => !f.dropped && f.outcome !== 'dismissed');
	const comments: ReviewComment[] = [];
	const unanchored: Finding[] = [];
	for (const f of live) {
		if (f.line && lines.get(f.file)?.has(f.line))
			comments.push({ path: f.file, line: f.line, body: renderFinding(f) });
		else unanchored.push(f);
	}
	const body = [
		`Integration Review: ${live.length} finding${live.length === 1 ? '' : 's'}.`,
		...unanchored.map(
			(f) => `${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`\n\n` : ''}${renderFinding(f)}`
		)
	].join('\n\n---\n\n');
	return { body, comments, ids: live.map((f) => f.id) };
}
