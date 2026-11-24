export type Column = 'inbox' | 'today' | 'working' | 'ready' | 'done';

/** A board card as `board()` in lib/server/conductor.ts returns it. */
export interface ConductorCard {
	id: string;
	/** Null for a ticket made in Corpus. */
	itemId: string | null;
	kind: 'ticket' | 'review';
	column: Column;
	provider: string;
	title: string;
	subtitle: string | null;
	/** Empty for a ticket made in Corpus. */
	url: string;
	body: string | null;
	state: string | null;
	ref: string | null;
	author: string | null;
	plannedFor: string | null;
	chatId: string | null;
	prUrl: string | null;
	note: string | null;
	/** Workbench workspace (worktree) the ticket's agents run in. */
	workspaceId: string | null;
	/** Repositories the ticket's agents work in. */
	repos: string[];
	/** One PR per repository the agent changed. */
	prs: { repo: string; number: number; url: string }[];
	/** Why a working ticket needs you (agent asked, failed, CI red, PR couldn't open). */
	blocked: string | null;
	/** The agent's closing summary. */
	summary: string | null;
	agentRunning: boolean;
	/** Its agent thread was removed in Workbench; Start opens a new one. */
	chatGone: boolean;
	agentName: string | null;
	/** Conductor is pushing / opening the PR right now. */
	opening: boolean;
	updatedAt: string;
	movedAt: string;
	review: {
		id: string;
		status: string;
		summary: string | null;
		findings: number;
		postedUrl: string | null;
		approvedUrl: string | null;
	} | null;
}
