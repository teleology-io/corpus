export type Channel = 'inApp' | 'push' | 'email';

export interface NotificationTypeDef {
	label: string;
	group: 'Schedule' | 'Health' | 'Tasks' | 'Notes' | 'Teams' | 'Integrations' | 'System';
	description: string;
	defaults: Record<Channel, boolean>;
}

const on = (email = false) => ({ inApp: true, push: true, email });

export const NOTIFICATION_TYPES = {
	event_starting: {
		label: 'Event starting',
		group: 'Schedule',
		description: 'Before a scheduled event begins',
		defaults: on()
	},
	event_invite: {
		label: 'Event invitation',
		group: 'Schedule',
		description: 'Someone adds you to an event',
		defaults: on(true)
	},
	reminder_due: {
		label: 'Reminders',
		group: 'Schedule',
		description: 'A reminder you set fires',
		defaults: on()
	},
	dose_due: {
		label: 'Dose due',
		group: 'Health',
		description: 'Time to take a cycle dose',
		defaults: on()
	},
	dose_missed: {
		label: 'Dose missed',
		group: 'Health',
		description: 'A dose was not logged within 2 hours',
		defaults: on()
	},
	cycle_phase: {
		label: 'Cycle phase change',
		group: 'Health',
		description: 'A cycle switches between on and off',
		defaults: on(true)
	},
	task_due: {
		label: 'Task due',
		group: 'Tasks',
		description: 'A task with a due time is coming up',
		defaults: on()
	},
	task_assigned: {
		label: 'Task assigned',
		group: 'Tasks',
		description: 'Someone assigns you a task',
		defaults: on(true)
	},
	note_shared: {
		label: 'Note shared',
		group: 'Notes',
		description: 'A note is shared with you',
		defaults: on(true)
	},
	note_mention: {
		label: 'Mentions',
		group: 'Notes',
		description: 'Someone @mentions you in a note',
		defaults: on(true)
	},
	team_invite: {
		label: 'Team invitations',
		group: 'Teams',
		description: 'You are invited to a workspace',
		defaults: on(true)
	},
	integration_review_request: {
		label: 'Review requested',
		group: 'Integrations',
		description: 'A pull request needs your review',
		defaults: on()
	},
	integration_pr_update: {
		label: 'Pull request updates',
		group: 'Integrations',
		description: 'Checks or review state change on your PRs',
		defaults: { inApp: true, push: false, email: false }
	},
	integration_issue_assigned: {
		label: 'Issue assigned',
		group: 'Integrations',
		description: 'A GitHub or Linear issue is assigned to you',
		defaults: on()
	},
	calendar_invite: {
		label: 'Calendar invitations',
		group: 'Integrations',
		description: 'Someone invites you to an event in a synced Google Calendar',
		defaults: on()
	},
	calendar_change: {
		label: 'Calendar changes',
		group: 'Integrations',
		description: 'An organizer moves or cancels a synced event',
		defaults: on()
	},
	slack_mention: {
		label: 'Slack mentions',
		group: 'Integrations',
		description: 'Someone @mentions you in Slack',
		defaults: on()
	},
	slack_thread_reply: {
		label: 'Slack thread replies',
		group: 'Integrations',
		description: 'New replies in Slack threads you follow',
		defaults: { inApp: true, push: true, email: false }
	},
	integration_error: {
		label: 'Integration errors',
		group: 'System',
		description: 'An integration needs to be reconnected',
		defaults: { inApp: true, push: false, email: true }
	},
	daily_digest: {
		label: 'Daily digest',
		group: 'System',
		description: 'Morning summary of your day',
		defaults: { inApp: false, push: false, email: true }
	}
} satisfies Record<string, NotificationTypeDef>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export interface NotificationInput {
	userId: string;
	workspaceId?: string | null;
	type: NotificationType;
	title: string;
	body?: string | null;
	href?: string | null;
	sourceType?: string;
	sourceId?: string;
	dedupeKey: string;
	data?: Record<string, unknown>;
}

/** Stable idempotency key: type + source + occurrence instant (+ offset). */
export function dedupeKey(parts: (string | number | Date | null | undefined)[]) {
	return parts
		.filter((p) => p !== null && p !== undefined)
		.map((p) => (p instanceof Date ? p.toISOString() : String(p)))
		.join(':');
}

export function resolvePrefs(
	type: NotificationType,
	stored?: Partial<Record<Channel, boolean>> | null
): Record<Channel, boolean> {
	return { ...NOTIFICATION_TYPES[type].defaults, ...(stored ?? {}) };
}

/** True when local "HH:mm" `now` falls inside quiet hours (handles overnight windows). */
export function inQuietHours(now: string, start?: string | null, end?: string | null) {
	if (!start || !end || start === end) return false;
	return start < end ? now >= start && now < end : now >= start || now < end;
}
