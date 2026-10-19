import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { db, schema } from '@corpus/db';
import { body } from '#lib/server/ctx.js';

const patch = z.object({
	name: z.string().trim().min(1).max(100).optional(),
	timezone: z
		.string()
		.refine((tz) => {
			try {
				new Intl.DateTimeFormat('en', { timeZone: tz });
				return true;
			} catch {
				return false;
			}
		}, 'Invalid timezone')
		.optional(),
	weekStartsOn: z.number().int().min(0).max(6).optional(),
	image: z.string().max(500).nullish()
});

export const PATCH: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, 'Not signed in');
	const values = await body(request, patch);
	await db.update(schema.user).set(values).where(eq(schema.user.id, locals.user.id));
	return new Response(null, { status: 204 });
};
