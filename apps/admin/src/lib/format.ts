const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "2 min ago", "in 30 sec", "—" */
export function ago(d: Date | string | null | undefined) {
	if (!d) return '—';
	const s = Math.round((new Date(d).getTime() - Date.now()) / 1000);
	const a = Math.abs(s);
	if (a < 60) return rtf.format(s, 'second');
	if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
	if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
	return rtf.format(Math.round(s / 86400), 'day');
}

export function stamp(d: Date | string | null | undefined) {
	if (!d) return '—';
	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit'
	}).format(new Date(d));
}

export function duration(ms: number | null | undefined) {
	if (ms == null) return '—';
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
