import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { body, requireCtx } from '#lib/server/ctx.js';
import { getSettings, setSetting } from '#lib/server/settings.js';
import { SETTINGS, parseSetting, type SettingKey } from '#lib/settings.js';

export const GET: RequestHandler = async ({ locals }) =>
	Response.json(
		await getSettings(requireCtx(locals).userId, Object.keys(SETTINGS) as SettingKey[])
	);

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const ctx = requireCtx(locals);
	const input = await body(request, z.object({ key: z.string().max(100), value: z.unknown() }));
	try {
		parseSetting(input.key, input.value);
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'Invalid setting');
	}
	return Response.json(await setSetting(ctx.userId, input.key, input.value));
};
