// Client-side generation: Liquid on this device first, then the hosted provider or the template,
// depending on the device preference and Workbench access. All paths use the same snapshot.
import { api } from '#lib/api.js';
import {
	defaultPlan,
	nextAfterLiquid,
	renderMarkdown,
	standupMessages,
	validatePlan,
	type Detail,
	type ProviderPref,
	type StandupPlan,
	type StandupResult,
	type StandupSnapshot,
	type Validation
} from './model.js';

export interface SignedSnapshot {
	payload: string;
	signature: string;
	hosted: { label: string } | null;
}

const LIQUID_LABEL = 'Liquid AI, on this device';
const LIQUID_TIMEOUT_MS = 120_000;

type Liquid =
	{ ok: true; plan: StandupPlan } | { ok: false; kind: 'unavailable' | 'invalid'; reason: string };

async function runLiquid(
	snapshot: StandupSnapshot,
	detail: Detail,
	onstatus: (s: string) => void
): Promise<Liquid> {
	const rw = await import('#lib/components/notes/rewrite.js');
	if (!(await rw.rewriteSupported()))
		return { ok: false, kind: 'unavailable', reason: 'this browser has no WebGPU' };
	// Never starts the ~850 MB download from here; that stays under the Rewrite setting's rules.
	// Every model file must be cached: a partial cache would make the worker fetch the rest.
	if (!(await rw.rewriteModelComplete()))
		return {
			ok: false,
			kind: 'unavailable',
			reason: 'the Liquid model isn’t downloaded on this device'
		};
	onstatus('Liquid AI is drafting on this device…');
	const { messages, maxNewTokens } = standupMessages(snapshot, detail);
	const text = await new Promise<string | Error>((resolve) => {
		let out = '';
		const timer = setTimeout(() => {
			job.cancel();
			resolve(new Error('Liquid timed out'));
		}, LIQUID_TIMEOUT_MS);
		const job = rw.startRewrite(messages, maxNewTokens, {
			ontoken: (t) => (out += t),
			ondone: () => {
				clearTimeout(timer);
				resolve(out);
			},
			onerror: (m) => {
				clearTimeout(timer);
				resolve(new Error(m));
			}
		});
	});
	if (text instanceof Error)
		return { ok: false, kind: 'unavailable', reason: `Liquid failed: ${text.message}` };
	const v = validatePlan(snapshot, text, detail);
	return v.ok
		? v
		: { ok: false, kind: 'invalid', reason: `Liquid output failed validation (${v.errors[0]})` };
}

async function runHosted(signed: SignedSnapshot, detail: Detail): Promise<Validation> {
	try {
		return await api<Validation>('/api/standup', {
			body: { payload: signed.payload, signature: signed.signature, detail }
		});
	} catch (e) {
		return { ok: false, errors: [(e as Error).message] };
	}
}

export async function generateStandup(input: {
	snapshot: StandupSnapshot;
	signed: SignedSnapshot;
	detail: Detail;
	pref: ProviderPref;
	onstatus: (s: string) => void;
}): Promise<StandupResult> {
	const { snapshot, signed, detail, pref, onstatus } = input;
	const hostedAllowed = !!signed.hosted;
	const result = (plan: StandupPlan, by: StandupResult['by'], note: string): StandupResult => ({
		markdown: renderMarkdown(snapshot, plan),
		plan,
		detail,
		by,
		note
	});
	const reasons: string[] = [];

	if (pref !== 'hosted') {
		const liquid: Liquid = await runLiquid(snapshot, detail, onstatus).catch((e: Error) => ({
			ok: false,
			kind: 'unavailable',
			reason: `Liquid failed: ${e.message}`
		}));
		if (liquid.ok) return result(liquid.plan, 'liquid', LIQUID_LABEL);
		reasons.push(liquid.reason);
	}
	const next =
		pref === 'hosted'
			? hostedAllowed
				? 'hosted'
				: 'template'
			: nextAfterLiquid(pref, hostedAllowed);
	if (next === 'hosted') {
		onstatus(`Drafting with ${signed.hosted!.label}…`);
		const hosted = await runHosted(signed, detail);
		if (hosted.ok)
			return result(
				hosted.plan,
				'hosted',
				[signed.hosted!.label, ...reasons.map((r) => `used because ${r}`)].join(' · ')
			);
		reasons.push(`hosted output failed validation (${hosted.errors[0]})`);
	} else if (pref === 'hosted') reasons.push('hosted generation needs Workbench access');
	else if (pref === 'liquid') reasons.push('hosted fallback is off for this device');
	else if (!hostedAllowed) reasons.push('no Workbench access for a hosted fallback');
	return result(defaultPlan(snapshot, detail), 'template', ['Template', ...reasons].join(' · '));
}
