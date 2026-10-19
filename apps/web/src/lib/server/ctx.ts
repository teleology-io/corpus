import { error } from '@sveltejs/kit';

export interface Ctx {
	userId: string;
	workspaceId: string;
	tz: string;
	user: NonNullable<App.Locals['user']>;
}

export function requireCtx(locals: App.Locals): Ctx {
	if (!locals.user) error(401, 'Not signed in');
	if (!locals.workspaceId) error(400, 'No active workspace');
	return {
		userId: locals.user.id,
		workspaceId: locals.workspaceId,
		tz: locals.user.timezone || 'UTC',
		user: locals.user
	};
}

/** Parse JSON body with a zod-like schema, 400 on failure. */
export async function body<T>(
	request: Request,
	schema: {
		safeParse(
			v: unknown
		):
			| { success: true; data: T }
			| { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
	}
): Promise<T> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		error(400, issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
	}
	return parsed.data;
}
