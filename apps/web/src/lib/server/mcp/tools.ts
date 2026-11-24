// What Workbench agents can do in Corpus. Nothing here deletes, shares, invites or pushes.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@corpus/db';
import {
	createEvent,
	eventInput,
	eventPatch,
	listCalendars,
	listOccurrences,
	updateEvent
} from '../calendar.js';
import { board, COLUMNS, conductorAllowed, createCard, LABEL, moveCard } from '../conductor.js';
import type { Ctx } from '../ctx.js';
import { createNote, requireNote, searchNotes } from '../notes.js';
import { createTask, listTasks, taskInput, updateTask } from '../planner.js';
import { agentForToken, knownProjects, spawnThread } from '../wrx/index.js';
import { noteDocument } from './note-doc.js';
import { tool as define, type Tool } from './protocol.js';

export interface AgentCtx extends Ctx {
	agent: NonNullable<ReturnType<typeof agentForToken>>;
}

const tool = define<AgentCtx>();
const when = z.iso.datetime({ offset: true });

// No attendees (that invites people) and no note linking; colour and timezone get defaults.
const eventFields = eventInput.omit({ attendees: true, noteId: true, color: true, timezone: true });
const newEvent = eventFields.extend({
	color: eventInput.shape.color.default('#2C87F2'),
	timezone: z.string().max(100).optional().describe("IANA name; defaults to the user's")
});
// Declared without defaults, so fields left out of a patch stay untouched.
const eventChange = z.object({
	eventId: z.uuid(),
	title: z.string().trim().min(1).max(200).optional(),
	description: z.string().max(5000).nullish(),
	location: z.string().max(300).nullish(),
	start: when.optional(),
	end: when.optional(),
	allDay: z.boolean().optional(),
	scope: z
		.enum(['this', 'following', 'all'])
		.optional()
		.describe('For recurring events. Default: this'),
	originalStart: when
		.optional()
		.describe("The occurrence's originalStart; required for recurring events")
});

const base: Tool<AgentCtx>[] = [
	tool({
		name: 'list_events',
		description: 'List calendar events between two times (at most 62 days apart).',
		write: false,
		input: z.object({ from: when, to: when, search: z.string().max(200).optional() }),
		run: async (ctx, i) => {
			const from = new Date(i.from);
			const to = new Date(i.to);
			if (to <= from || to.getTime() - from.getTime() > 62 * 86_400_000)
				throw new Error('Choose a range of up to 62 days');
			const rows = await listOccurrences(ctx, from, to, { search: i.search });
			return {
				now: new Date().toISOString(),
				timezone: ctx.tz,
				events: rows.slice(0, 200).map((e) => ({
					eventId: e.eventId,
					title: e.title,
					start: e.start,
					end: e.end,
					originalStart: e.originalStart,
					allDay: e.allDay,
					recurring: e.recurring,
					location: e.location,
					description: e.description?.slice(0, 500) ?? null,
					calendarId: e.calendarId,
					canEdit: e.canEdit
				}))
			};
		}
	}),
	tool({
		name: 'list_calendars',
		description: 'List the calendars events can go in.',
		write: false,
		input: z.object({}),
		run: (ctx) => listCalendars(ctx.workspaceId)
	}),
	tool({
		name: 'create_event',
		description: 'Add a calendar event. Check list_events first to avoid duplicates and conflicts.',
		write: true,
		input: newEvent,
		run: async (ctx, i) => {
			const row = await createEvent(
				ctx,
				eventInput.parse({ ...i, timezone: i.timezone ?? ctx.tz, attendees: [] })
			);
			return { eventId: row.id, href: `/calendar?event=${row.id}` };
		}
	}),
	tool({
		name: 'update_event',
		description: 'Change a calendar event. Only the fields given change.',
		write: true,
		input: eventChange,
		run: async (ctx, { eventId, scope, ...patch }) => {
			const [row] = await db
				.select({ rrule: schema.event.rrule })
				.from(schema.event)
				.where(eq(schema.event.id, eventId));
			if (row?.rrule && !patch.originalStart)
				throw new Error('Recurring event: pass originalStart from list_events, and scope');
			await updateEvent(ctx, eventId, eventPatchOnly({ ...patch, scope: scope ?? 'this' }));
			return { eventId, href: `/calendar?event=${eventId}` };
		}
	}),
	tool({
		name: 'search_notes',
		description: 'Search notes by title and text.',
		write: false,
		input: z.object({ query: z.string().trim().min(1).max(200) }),
		run: (ctx, i) => searchNotes(ctx, i.query)
	}),
	tool({
		name: 'read_note',
		description: "Read a note's plain text.",
		write: false,
		input: z.object({ noteId: z.uuid() }),
		run: async (ctx, i) => {
			const { note } = await requireNote(ctx, i.noteId);
			return { title: note.title, text: note.contentText };
		}
	}),
	tool({
		name: 'create_note',
		description: 'Create a note from Markdown. Put the title in `title`, not in the body.',
		write: true,
		input: z.object({
			title: z.string().trim().min(1).max(300),
			markdown: z.string().max(100_000).default(''),
			parentId: z.uuid().optional()
		}),
		run: async (ctx, i) => {
			const row = await createNote(ctx, { title: i.title, parentId: i.parentId });
			if (i.markdown.trim())
				await db
					.update(schema.note)
					.set(noteDocument(i.markdown))
					.where(eq(schema.note.id, row.id));
			return { noteId: row.id, href: `/notes/${row.id}` };
		}
	}),
	tool({
		name: 'list_tasks',
		description: 'List open planner tasks.',
		write: false,
		input: z.object({}),
		run: async (ctx) =>
			(await listTasks(ctx, { completed: false })).map((t) => ({
				id: t.id,
				title: t.title,
				dueAt: t.dueAt,
				priority: t.priority
			}))
	}),
	tool({
		name: 'create_task',
		description: 'Create a planner task. Check list_tasks first; do not duplicate.',
		write: true,
		input: taskInput.omit({ assigneeId: true }),
		run: async (ctx, i) => ({ id: (await createTask(ctx, i)).id })
	}),
	tool({
		name: 'set_task_completed',
		description: 'Mark a planner task done or not done.',
		write: true,
		input: z.object({ taskId: z.uuid(), completed: z.boolean() }),
		run: async (ctx, i) => {
			await updateTask(ctx, i.taskId, { completed: i.completed });
			return { id: i.taskId, completed: i.completed };
		}
	}),
	tool({
		name: 'list_projects',
		description: 'List Workbench projects (repositories) and their workspaces.',
		write: false,
		input: z.object({}),
		run: async (ctx) => knownProjects(ctx.userId)
	}),
	tool({
		name: 'start_thread',
		description:
			'Start a new agent thread in a workspace from list_projects. It runs on its own; you do not get its replies. Use only when the human asked for it.',
		write: true,
		input: z.object({
			workspaceId: z.string().max(100),
			title: z.string().trim().min(1).max(200),
			prompt: z.string().trim().min(1).max(20_000),
			provider: z.enum(['claude', 'codex']).default('claude'),
			mode: z.enum(['assess', 'implement', 'review']).default('assess')
		}),
		run: async (ctx, i) => spawnThread(ctx.userId, ctx.agent.chat, i)
	})
];

// eventPatch fills defaults in; keep only what was asked for.
function eventPatchOnly(patch: Record<string, unknown>) {
	const keys = new Set(Object.keys(patch).filter((k) => patch[k] !== undefined));
	const full = eventPatch.parse(patch);
	return Object.fromEntries(Object.entries(full).filter(([k]) => keys.has(k))) as typeof full;
}

const conductor: Tool<AgentCtx>[] = [
	tool({
		name: 'conductor_list',
		description: 'List Conductor cards (tickets and reviews) with their column.',
		write: false,
		input: z.object({}),
		run: async (ctx) =>
			(await board(ctx.userId)).cards.map((c) => ({
				id: c.id,
				kind: c.kind,
				column: c.column,
				title: c.title,
				ref: c.ref,
				url: c.url || null,
				blocked: c.blocked,
				prUrl: c.prUrl
			}))
	}),
	tool({
		name: 'conductor_move',
		description: `Move a Conductor card to a column: ${COLUMNS.map((c) => `${c} (${LABEL[c]})`).join(', ')}. Moving does not start agents.`,
		write: true,
		input: z.object({ cardId: z.uuid(), column: z.enum(COLUMNS) }),
		run: async (ctx, i) => {
			await moveCard(ctx.userId, i.cardId, i.column, ctx.agent.member.name);
			return i;
		}
	}),
	tool({
		name: 'conductor_create',
		description:
			'Create a Conductor card, only when the human asked for one. The card lives in Corpus; no Linear or GitHub issue is made. If an open card already has this title, nothing is created and that card is returned. Check conductor_list for the same work under another title first.',
		write: true,
		input: z.object({
			title: z.string().trim().min(1).max(300),
			body: z.string().max(20_000).default(''),
			column: z.enum(COLUMNS).default('inbox')
		}),
		run: (ctx, i) => createCard(ctx.userId, i, ctx.agent.member.name)
	})
];

export const toolsFor = (email: string) =>
	conductorAllowed(email) ? [...base, ...conductor] : base;
