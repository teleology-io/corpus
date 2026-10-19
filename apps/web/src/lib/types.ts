// Client-safe DTOs shared between server loaders/endpoints and components.

export interface Person {
	id?: string | null;
	name: string;
	email?: string | null;
	image?: string | null;
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
	author: { name: string; image: string | null };
	mine: boolean;
	edited: boolean;
	segments: SlackSegment[];
	files: { name: string; url: string }[];
}
