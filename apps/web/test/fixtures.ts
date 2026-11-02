import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db, schema, sql } from '@corpus/db';
import { resetTestDatabase } from '@corpus/db/testing';
import type { Ctx } from '#lib/server/ctx.js';

type User = NonNullable<App.Locals['user']>;

/** Wipe all data — refuses unless connected to this run's marked corpus_test_* database. */
export async function reset() {
	const runId = process.env.CORPUS_TEST_RUN_ID;
	if (!runId) throw new Error('CORPUS_TEST_RUN_ID missing — worker setup did not run');
	await resetTestDatabase(sql, runId);
}

export async function makeUser(name: string): Promise<User> {
	const [row] = await db
		.insert(schema.user)
		.values({ id: randomUUID(), name, email: `${name.toLowerCase()}@test.local` })
		.returning();
	return row as User;
}

export async function makeWorkspace(name: string, kind: 'org' | 'personal' = 'org') {
	const id = randomUUID();
	await db
		.insert(schema.organization)
		.values({
			id,
			name,
			slug: `${name.toLowerCase()}-${id.slice(0, 8)}`,
			kind,
			createdAt: new Date()
		});
	return id;
}

export async function addMember(workspaceId: string, userId: string, role = 'member') {
	await db
		.insert(schema.member)
		.values({ id: randomUUID(), organizationId: workspaceId, userId, role, createdAt: new Date() });
}

export async function setMemberRole(workspaceId: string, userId: string, role: string) {
	await db
		.update(schema.member)
		.set({ role })
		.where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, userId)));
}

export async function removeMember(workspaceId: string, userId: string) {
	await db
		.delete(schema.member)
		.where(and(eq(schema.member.organizationId, workspaceId), eq(schema.member.userId, userId)));
}

export async function makeNote(workspaceId: string, createdBy: string, parentId?: string) {
	const [row] = await db
		.insert(schema.note)
		.values({ workspaceId, createdBy, parentId: parentId ?? null, title: 'Plan' })
		.returning();
	return row!;
}

export async function shareWith(
	noteId: string,
	userId: string,
	role: 'view' | 'comment' | 'edit',
	createdBy: string
) {
	const [row] = await db
		.insert(schema.noteShare)
		.values({ noteId, userId, role, createdBy })
		.returning();
	return row!;
}

export async function makeLink(noteId: string, role: 'view' | 'edit', createdBy: string) {
	const [row] = await db
		.insert(schema.noteLink)
		.values({ noteId, token: `tok_${randomUUID()}`, role, createdBy })
		.returning();
	return row!;
}

export const ctxFor = (user: User, workspaceId: string): Ctx => ({
	userId: user.id,
	workspaceId,
	tz: 'UTC',
	user
});

export const localsFor = (user: User, workspaceId: string) =>
	({ user, session: null, workspaceId }) as unknown as App.Locals;

/** Asserts the promise rejects with a SvelteKit HttpError of the given status. */
export async function expectStatus(p: Promise<unknown>, status: number) {
	let caught: unknown;
	try {
		await p;
	} catch (e) {
		caught = e;
	}
	expect(caught, `expected HTTP ${status}, but the call succeeded`).toBeDefined();
	if (!isHttpError(caught)) throw caught;
	expect(caught.status).toBe(status);
}

export async function sharesOf(noteId: string) {
	return db.select().from(schema.noteShare).where(eq(schema.noteShare.noteId, noteId));
}

export async function linksOf(noteId: string) {
	return db.select().from(schema.noteLink).where(eq(schema.noteLink.noteId, noteId));
}
