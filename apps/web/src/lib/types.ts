// Client-safe DTOs shared between server loaders/endpoints and components.

export interface Person {
	id?: string | null;
	name: string;
	email?: string | null;
	image?: string | null;
	/** Event attendees only: pending | accepted | declined | tentative */
	rsvp?: string;
}

export interface CategoryDTO {
	id: string;
	name: string;
	icon: string;
	color: string;
}

export interface OccurrenceDTO {
	key: string;
	eventId: string;
	calendarId: string;
	title: string;
	description: string | null;
	location: string | null;
	color: string;
	opacity: number;
	start: string;
	end: string;
	originalStart: string;
	allDay: boolean;
	recurring: boolean;
	rrule: string | null;
	timezone: string;
	reminders: number[];
	category: CategoryDTO | null;
	attendees: Person[];
	noteId: string | null;
	canEdit: boolean;
	/** Set when the event mirrors an external calendar (Google) */
	external: {
		provider: string;
		url: string | null;
		meetUrl: string | null;
		/** Organizer, when it isn't you */
		organizer: string | null;
	} | null;
}

export interface CalendarDTO {
	id: string;
	name: string;
	color: string;
	isDefault: boolean;
	readOnly: boolean;
	/** 'google-calendar' for synced calendars, null for local ones */
	provider: string | null;
	account: string | null;
}

export interface CycleBandDTO {
	cycleId: string;
	name: string;
	color: string;
	status: 'on' | 'off';
	start: string; // YYYY-MM-DD
	end: string;
	cycleNumber: number;
}

export interface DoseDTO {
	cycleId: string;
	name: string;
	doseLabel: string | null;
	color: string;
	at: string;
	status: 'taken' | 'skipped' | 'missed' | null;
}

/** One row in the app-wide ⌘K search palette. */
export interface SearchResult {
	kind: string;
	title: string;
	detail: string;
	href: string;
	/** Opens in a new tab (integration items) */
	external?: boolean;
}

/** Partial source failures preserve successful search results. */
export interface SearchResponse {
	results: SearchResult[];
	failedSources: string[];
}

/** A task from the Workbench (ported WRX) board, shown on the dashboard. */
export interface WorkbenchTaskDTO {
	id: string;
	title: string;
	status: 'todo' | 'doing' | 'done';
	createdAt: string;
	completedAt: string | null;
	workspaceId: string;
	workspace: string | null;
	project: string | null;
}

export interface TaskDTO {
	id: string;
	title: string;
	notes: string | null;
	dueAt: string | null;
	dueAllDay: boolean;
	priority: number;
	completedAt: string | null;
	source: string;
	externalUrl: string | null;
	assignee: Person | null;
}

export interface ReminderOccurrenceDTO {
	reminderId: string;
	title: string;
	at: string;
	recurring: boolean;
}

export interface IntegrationItemDTO {
	id: string;
	provider: string;
	kind: string;
	title: string;
	subtitle: string | null;
	url: string;
	state: string | null;
	updatedAt: string | null;
	payload: Record<string, unknown> | null;
}

export interface NotificationDTO {
	id: string;
	type: string;
	title: string;
	body: string | null;
	href: string | null;
	readAt: string | null;
	createdAt: string;
}

export type EditScope = 'this' | 'following' | 'all';

export interface NoteTreeItem {
	id: string;
	parentId: string | null;
	title: string;
	icon: string | null;
	position: number;
	updatedAt: string;
}

export interface SlackThreadDTO {
	id: string;
	channelName: string | null;
	preview: string | null;
	authorName: string | null;
	replyCount: number;
	permalink: string | null;
	/** Followed because you were @mentioned */
	mentioned: boolean;
	followed: boolean;
	unread: boolean;
	lastActivityAt: string | null;
}

export type SlackSegment =
	| { t: 'text' | 'bold' | 'italic' | 'strike' | 'code' | 'pre'; v: string }
	| { t: 'link'; href: string; v: string }
	| { t: 'user'; id: string; v: string }
	| { t: 'channel'; id: string; v: string };

export interface SlackMessageDTO {
	ts: string;
	at: string;
	/** Parent thread ts (roots carry their own ts) */
	threadTs: string | null;
	replyCount: number;
	author: { id: string | null; name: string; image: string | null };
	mine: boolean;
	edited: boolean;
	deleted: boolean;
	/** Join/leave/topic and other system messages */
	system: boolean;
	segments: SlackSegment[];
	/** Metadata only — links open in Slack; nothing is downloaded */
	files: { name: string; url: string | null; size: number | null; mimetype: string | null }[];
}

export interface SlackConversationDTO {
	id: string;
	kind: 'public' | 'private' | 'im' | 'mpim';
	/** Display name: #channel, DM partner, or group DM members */
	name: string;
	topic: string | null;
	image: string | null;
	unread: boolean;
	latestAt: string | null;
	inaccessible: string | null;
}

export interface SlackMessagesPage {
	messages: SlackMessageDTO[];
	/** Messages already shown that were edited or deleted since the last poll */
	changed: SlackMessageDTO[];
	hasOlder: boolean;
	/** Slack (or our budget) asked us to wait — poll no sooner than this */
	retryAfterSec: number | null;
	/** history is on the 1 req/min limit: poll slowly */
	restricted: boolean;
	error: string | null;
	/** Server time the poll started — pass back as `changedSince` */
	syncedAt: string;
}

export interface SlackSearchResultDTO {
	kind: 'message' | 'file';
	channelId: string | null;
	channelName: string;
	ts: string;
	threadTs: string | null;
	at: string;
	author: string;
	segments: SlackSegment[];
	permalink: string | null;
	fileName?: string;
}

export interface SlackIdentityDTO {
	userId: string | null;
	teamName: string | null;
	account: string | null;
	status: string;
	error: string | null;
	lastSyncedAt: string | null;
	missingScopes: string[];
	restricted: boolean;
}
