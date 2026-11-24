/** True when `href` points off-origin (e.g. a GitHub PR), so it should open in a new tab. */
export function isExternalHref(href: string | null | undefined): boolean {
	if (!href || (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//'))) return false;
	try {
		const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
		return new URL(href, origin).origin !== origin;
	} catch {
		return false;
	}
}

/** Anchor attrs for a link: new tab + noopener for external targets, nothing for in-app ones. */
export function linkTarget(href: string | null | undefined) {
	return isExternalHref(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {};
}
