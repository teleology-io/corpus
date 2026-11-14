import { error, fail } from '@sveltejs/kit';
import { isJobName, JOBS, requestJobRun, setJobPaused } from '@corpus/db/ops';
import { logAction, requireReason } from '#lib/server/actions.js';
import { jobRuns, jobs, services } from '#lib/server/queries.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, depends }) => {
	depends('admin:jobs');
	const selected = url.searchParams.get('job');
	const [list, runs] = await Promise.all([
		jobs(),
		selected && isJobName(selected) ? jobRuns(selected) : Promise.resolve(null)
	]);
	return { jobs: list, selected: list.find((j) => j.name === selected) ?? null, runs };
};

function jobFrom(form: FormData) {
	const name = String(form.get('job') ?? '');
	if (!isJobName(name)) error(400, 'Unknown job');
	return { name, target: { type: 'job', id: name, label: JOBS[name].label } };
}

export const actions: Actions = {
	run: async ({ request, locals }) => {
		const { name, target } = jobFrom(await request.formData());
		const worker = (await services()).find((s) => s.id === 'worker');
		if (worker?.health !== 'healthy')
			return fail(503, {
				error: 'The worker isn’t running, so nothing would pick this up. Start it and try again.'
			});
		await requestJobRun(name);
		await logAction(locals.admin!, 'job.run', target);
	},
	pause: async ({ request, locals }) => {
		const form = await request.formData();
		const { name, target } = jobFrom(form);
		const r = requireReason(form);
		if ('error' in r) return r.error;
		await setJobPaused(name, true, locals.admin!.email);
		await logAction(locals.admin!, 'job.pause', target, r.reason);
	},
	resume: async ({ request, locals }) => {
		const { name, target } = jobFrom(await request.formData());
		await setJobPaused(name, false, locals.admin!.email);
		await logAction(locals.admin!, 'job.resume', target);
	}
};
