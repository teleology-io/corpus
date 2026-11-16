// Hosted fallback: the Workbench provider CLI, one-shot and tool-free (same lockdown as the
// Integration Review "voice" run). Only ever sees the signed evidence snapshot.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { standupMessages, type Detail, type StandupSnapshot } from '#lib/standup/model.js';
import { reviewEnv, runAgent, type Spawn } from '../pr-review/runner.js';
import { agentEnv } from '../wrx/core.js';

export const HOSTED_LABEL = 'Claude Haiku via Workbench (hosted)';
const HOSTED_TIMEOUT_MS = 90_000;

export async function generateHosted(snapshot: StandupSnapshot, detail: Detail) {
	const { messages } = standupMessages(snapshot, detail);
	const prompt = messages.map((m) => m.content).join('\n\n');
	// An empty directory, so no project config or files are anywhere near the run.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-standup-'));
	try {
		const run = await runAgent({
			slot: { provider: 'claude', model: 'haiku', tools: false },
			prompt,
			cwd,
			env: reviewEnv(agentEnv()),
			spawn: spawn as unknown as Spawn,
			timeoutMs: HOSTED_TIMEOUT_MS
		});
		return { text: run.text, error: run.error };
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}
