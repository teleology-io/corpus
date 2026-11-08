/** Slack search modifiers composed into one query string (search.all syntax). */
export interface SlackQueryParts {
	text?: string;
	/** channel name (#general) or DM partner (@alice) */
	in?: string;
	/** person (@alice) */
	from?: string;
	/** YYYY-MM-DD */
	after?: string;
	before?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const word = (s: string) => s.trim().replace(/\s+/g, '-');

export function buildSlackQuery(p: SlackQueryParts) {
	const parts: string[] = [];
	if (p.text?.trim()) parts.push(p.text.trim());
	if (p.in?.trim()) {
		const v = word(p.in);
		parts.push(`in:${/^[#@<]/.test(v) ? v : `#${v}`}`);
	}
	if (p.from?.trim()) {
		const v = word(p.from);
		parts.push(`from:${/^[@<]/.test(v) ? v : `@${v}`}`);
	}
	if (p.after && DATE.test(p.after)) parts.push(`after:${p.after}`);
	if (p.before && DATE.test(p.before)) parts.push(`before:${p.before}`);
	return parts.join(' ');
}

/** Inverse of buildSlackQuery for the modifiers we know; everything else stays in `text`. */
export function parseSlackQuery(q: string): SlackQueryParts {
	const out: SlackQueryParts = {};
	const rest: string[] = [];
	for (const tok of q.trim().split(/\s+/).filter(Boolean)) {
		const m = tok.match(/^(in|from|after|before):(.+)$/i);
		if (!m) {
			rest.push(tok);
			continue;
		}
		const key = m[1]!.toLowerCase() as 'in' | 'from' | 'after' | 'before';
		if (out[key]) rest.push(tok);
		else out[key] = m[2]!;
	}
	out.text = rest.join(' ');
	return out;
}
