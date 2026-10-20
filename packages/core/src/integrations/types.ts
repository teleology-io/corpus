export type ProviderId = 'github' | 'linear' | 'google-calendar' | 'slack';

export type ItemKind = 'review_request' | 'pull_request' | 'issue';

/** Normalized provider item, upserted into integration_item. */
export interface ExternalItem {
	externalId: string;
	kind: ItemKind;
	title: string;
	subtitle?: string;
	url: string;
	state?: string;
	externalUpdatedAt?: string;
	dueDate?: string | null;
	payload?: Record<string, unknown>;
}

/** Full description of one item, fetched when the user opens a preview. */
export interface ItemPreview {
	format: 'html' | 'markdown';
	body: string | null;
}

export interface TokenSet {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: Date | null;
	scopes?: string | null;
}

export interface AccountInfo {
	login: string;
	avatarUrl?: string | null;
}

export interface PollResult {
	/** Full current set of open items for this user (provider-side filtered). */
	items: ExternalItem[];
	cursor: Record<string, string>;
	/** Provider-suggested poll interval in seconds */
	pollIntervalSec?: number;
	/** true when the provider said nothing changed (e.g. 304) — keep existing items */
	notModified?: boolean;
}

export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

export interface Provider {
	id: ProviderId;
	name: string;
	/** Env var prefix for {PREFIX}_CLIENT_ID / _SECRET (defaults to the id uppercased). */
	envPrefix?: string;
	/** Where admins register the OAuth app (shown in the setup form). */
	appSetupUrl: string;
	/** Set when a user can connect with a pasted personal token instead of OAuth. */
	personalToken?: { label: string; createUrl: string; hint: string };
	authorizeUrl(cfg: OAuthConfig, state: string): string;
	exchangeCode(cfg: OAuthConfig, code: string): Promise<TokenSet>;
	refresh?(cfg: OAuthConfig, refreshToken: string): Promise<TokenSet>;
	account(token: string): Promise<AccountInfo>;
	/** Item-feed providers (GitHub, Linear). Sync providers (Google, Slack) have workers of their own. */
	poll?(token: string, cursor: Record<string, string>): Promise<PollResult>;
	/** Description of one polled item (externalId as returned by poll). */
	preview?(token: string, externalId: string): Promise<ItemPreview>;
}

export class ProviderAuthError extends Error {}
