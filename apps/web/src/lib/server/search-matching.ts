import { and, sql, type AnyColumn, type SQL } from 'drizzle-orm';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const termsOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
/** Every whitespace-separated term appears somewhere in the haystack. */
export const matcher = (q: string) => {
	const terms = termsOf(q);
	return (...fields: (string | null | undefined)[]) => {
		const text = fields.filter(Boolean).join(' ').toLowerCase();
		return terms.every((t) => text.includes(t));
	};
};
/**
 * SQL twin of `matcher`: each term must appear in the fields joined with spaces (concat_ws
 * skips nulls, like the JS filter), so filtering and limiting happen in the database instead
 * of loading every row per keystroke.
 */
export const sqlMatcher = (q: string) => {
	const terms = termsOf(q);
	return (...fields: (AnyColumn | SQL)[]): SQL | undefined => {
		const haystack = sql`concat_ws(' ', ${sql.join(fields, sql`, `)})`;
		return terms.length ? and(...terms.map((t) => sql`${haystack} ilike ${like(t)}`)) : undefined;
	};
};

/** Exact title, title prefix, all terms in title, then body-only matches. */
export const sqlRank = (q: string, title: AnyColumn) => sql<number>`case
 when lower(${title}) = ${q.toLowerCase()} then 0
 when ${title} ilike ${like(q).slice(1)} then 1
 when ${sqlMatcher(q)(title)} then 2
 else 3 end`;

export function searchRank(q: string, title: string): number {
	const text = title.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '');
	const query = q.toLowerCase();
	return text === query ? 0 : text.startsWith(query) ? 1 : matcher(q)(text) ? 2 : 3;
}
