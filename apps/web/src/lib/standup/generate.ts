// Client-side generation: Liquid on this device first, then the hosted provider or the template,
// depending on the device preference and Workbench access. All paths use the same snapshot.
import { api } from '#lib/api.js';
import {
	defaultPlan,
	nextAfterLiquid,
	renderMarkdown,
	selectToday,
	separateReviews,
	standupMessages,
	validatePlan,
	type Detail,
	type GenerationAttempt,
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

const OUTPUT_SAMPLE = 1500;

async function runLiquid(
	snapshot: StandupSnapshot,
	detail: Detail,
	onstatus: (s: string) => void
): Promise<GenerationAttempt & { plan?: StandupPlan }> {
	const started = Date.now();
	const rw = await import('#lib/components/notes/rewrite.js');
	const { readRewritePrefs } = await import('#lib/stores/rewrite-prefs.js');
	const checks: Record<string, boolean | string> = {
		secureContext: !!globalThis.isSecureContext,
		webgpuApi: typeof navigator !== 'undefined' && 'gpu' in navigator,
		rewriteEnabled: readRewritePrefs().enabled
	};
	const unavailable = (reason: string) => ({
		provider: 'liquid' as const,
		outcome: 'unavailable' as const,
		reason,
		checks,
		ms: Date.now() - started
	});
	checks.webgpuAdapter = await rw.rewriteSupported();
	if (!checks.secureContext)
		return unavailable('this page isn’t on HTTPS or localhost, so WebGPU is off');
	if (!checks.webgpuAdapter)
		return unavailable(
			checks.webgpuApi
				? 'WebGPU found no usable GPU adapter in this browser'
				: 'this browser has no WebGPU'
		);
	// Never starts the ~850 MB download from here; that stays under the Rewrite setting's rules.
	// Every model file must be cached: a partial cache would make the worker fetch the rest.
	checks.modelCacheExists = await rw.rewriteModelStored();
	checks.modelComplete = await rw.rewriteModelComplete();
	if (!checks.modelComplete)
		return unavailable(
			!checks.rewriteEnabled
				? 'the Liquid model isn’t downloaded on this device (Rewrite in notes is off here, so it won’t download)'
				: checks.modelCacheExists
					? 'the Liquid model is only partly downloaded on this device'
					: 'the Liquid model isn’t downloaded on this device'
		);
	onstatus('Liquid AI is drafting on this device…');
	const { messages, maxNewTokens } = standupMessages(snapshot, detail);
	const text = await new Promise<string | Error>((resolve) => {
		let out = '';
		const timer = setTimeout(() => {
			job.cancel();
			resolve(new Error(`timed out after ${LIQUID_TIMEOUT_MS / 1000}s`));
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
	const ms = Date.now() - started;
	if (text instanceof Error)
		return {
			provider: 'liquid',
			outcome: 'error',
			reason: `Liquid failed: ${text.message}`,
			checks,
			ms
		};
	const v = validatePlan(snapshot, text, detail);
	if (v.ok)
		return { provider: 'liquid', outcome: 'used', reason: LIQUID_LABEL, checks, ms, plan: v.plan };
	return {
		provider: 'liquid',
		outcome: 'invalid',
		reason: `Liquid output failed validation (${v.errors[0]})`,
		errors: v.errors,
		output: text.slice(0, OUTPUT_SAMPLE),
		checks,
		ms
	};
}

async function runHosted(
	signed: SignedSnapshot,
	detail: Detail,
	selected: readonly string[]
): Promise<Validation | { ok: false; errors: string[]; requestFailed: true }> {
	try {
		return await api<Validation>('/api/standup', {
			body: { payload: signed.payload, signature: signed.signature, detail, selected }
		});
	} catch (e) {
		return { ok: false, errors: [(e as Error).message], requestFailed: true };
	}
}

export async function generateStandup(input: {
	snapshot: StandupSnapshot;
	signed: SignedSnapshot;
	detail: Detail;
	pref: ProviderPref;
	/** Today checklist picks (item ids), meetings included. */
	selected: readonly string[];
	onstatus: (s: string) => void;
}): Promise<StandupResult> {
	const { signed, detail, pref, onstatus, selected } = input;
	// Every writer, and the hosted server, works from this same filtered set.
	const snapshot = selectToday(input.snapshot, selected);
	const hostedAllowed = !!signed.hosted;
	const attempts: GenerationAttempt[] = [];
	const result = (plan: StandupPlan, by: StandupResult['by'], note: string): StandupResult => {
		// Kept in the console too, so a fallback can be traced after the sheet is closed.
		console.info('[standup] generation', { by, attempts });
		const ordered = separateReviews(snapshot, plan);
		return {
			markdown: renderMarkdown(snapshot, ordered),
			plan: ordered,
			detail,
			by,
			note,
			attempts
		};
	};
	const reasons: string[] = [];

	if (pref !== 'hosted') {
		const liquid = await runLiquid(snapshot, detail, onstatus).catch(
			(e: Error): GenerationAttempt => ({
				provider: 'liquid',
				outcome: 'error',
				reason: `Liquid failed: ${e.message}`
			})
		);
		const { plan, ...attempt } = liquid as GenerationAttempt & { plan?: StandupPlan };
		attempts.push(attempt);
		if (plan) return result(plan, 'liquid', LIQUID_LABEL);
		reasons.push(attempt.reason);
	} else
		attempts.push({
			provider: 'liquid',
			outcome: 'skipped',
			reason: 'device setting is Hosted only'
		});
	const next =
		pref === 'hosted'
			? hostedAllowed
				? 'hosted'
				: 'template'
			: nextAfterLiquid(pref, hostedAllowed);
	if (next === 'hosted') {
		onstatus(`Drafting with ${signed.hosted!.label}…`);
		const started = Date.now();
		const hosted = await runHosted(signed, detail, selected);
		const ms = Date.now() - started;
		if (hosted.ok) {
			attempts.push({ provider: 'hosted', outcome: 'used', reason: signed.hosted!.label, ms });
			return result(
				hosted.plan,
				'hosted',
				[signed.hosted!.label, ...reasons.map((r) => `used because ${r}`)].join(' · ')
			);
		}
		const failed = 'requestFailed' in hosted;
		const reason = failed
			? `hosted request failed (${hosted.errors[0]})`
			: `hosted output failed validation (${hosted.errors[0]})`;
		attempts.push({
			provider: 'hosted',
			outcome: failed ? 'error' : 'invalid',
			reason,
			errors: hosted.errors,
			ms
		});
		reasons.push(reason);
	} else {
		const reason =
			pref === 'hosted'
				? 'hosted generation needs Workbench access'
				: pref === 'liquid'
					? 'hosted fallback is off for this device'
					: 'no Workbench access for a hosted fallback';
		attempts.push({ provider: 'hosted', outcome: 'skipped', reason });
		reasons.push(reason);
	}
	attempts.push({ provider: 'template', outcome: 'used', reason: 'deterministic renderer' });
	return result(defaultPlan(snapshot, detail), 'template', ['Template', ...reasons].join(' · '));
}
