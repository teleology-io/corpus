// The part of MCP's streamable HTTP transport that stateless tools need: JSON-RPC over POST.
import { z } from 'zod';

export interface Tool<C> {
	name: string;
	description: string;
	/** Changes something: only agents that may write see it or can call it. */
	write: boolean;
	input: z.ZodType;
	run: (ctx: C, input: never) => Promise<unknown>;
}

/** Types `run`'s input from the schema. */
export const tool =
	<C>() =>
	<S extends z.ZodType>(
		t: Omit<Tool<C>, 'input' | 'run'> & {
			input: S;
			run: (ctx: C, input: z.output<S>) => Promise<unknown>;
		}
	): Tool<C> =>
		t as unknown as Tool<C>;

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const message = z.object({
	jsonrpc: z.literal('2.0'),
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string(),
	params: z.record(z.string(), z.unknown()).optional()
});

const errorText = (e: unknown) => {
	// SvelteKit's error() throws { status, body: { message } }. Anything else may be a database error
	// that spells out its query, so only Errors thrown on purpose by the tools are repeated.
	const body = (e as { body?: { message?: string } } | null)?.body;
	if (body?.message) return body.message;
	if (e instanceof Error && e.constructor === Error && !('cause' in e && e.cause)) return e.message;
	console.error('mcp', e);
	return 'Something went wrong';
};

/** Answers one JSON-RPC message; null for notifications. */
export async function handleMessage<C>(
	raw: unknown,
	opts: { tools: Tool<C>[]; canWrite: boolean; context: () => Promise<C>; instructions: string }
): Promise<Record<string, unknown> | null> {
	const parsed = message.safeParse(raw);
	if (!parsed.success)
		return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
	const { id, method, params = {} } = parsed.data;
	if (id === undefined) return null;
	const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
	const fail = (code: number, text: string) => ({
		jsonrpc: '2.0',
		id,
		error: { code, message: text }
	});
	const toolError = (text: string) => ok({ content: [{ type: 'text', text }], isError: true });

	switch (method) {
		case 'initialize': {
			const asked = String(params.protocolVersion ?? '');
			return ok({
				protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[1],
				capabilities: { tools: {} },
				serverInfo: { name: 'corpus', version: '1.0.0' },
				instructions: opts.instructions
			});
		}
		case 'ping':
			return ok({});
		case 'tools/list':
			return ok({
				tools: opts.tools
					.filter((t) => opts.canWrite || !t.write)
					.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
						annotations: {
							readOnlyHint: !t.write,
							destructiveHint: false,
							openWorldHint: false
						}
					}))
			});
		case 'tools/call': {
			const found = opts.tools.find((t) => t.name === params.name);
			if (!found) return fail(-32602, 'Unknown tool');
			// Checked on every call: a client may remember tools from before its permissions changed.
			if (found.write && !opts.canWrite)
				return toolError('This agent is read-only. Ask the human to allow writes for it.');
			const input = found.input.safeParse(params.arguments ?? {});
			if (!input.success) {
				const issue = input.error.issues[0];
				return toolError(`${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`);
			}
			try {
				const result = await found.run(await opts.context(), input.data as never);
				return ok({ content: [{ type: 'text', text: JSON.stringify(result) }] });
			} catch (e) {
				return toolError(errorText(e));
			}
		}
		default:
			return fail(-32601, 'Method not found');
	}
}
