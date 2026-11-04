// Runs the rewrite model off the main thread. Only loaded on first use, so Transformers.js stays
// out of the notes bundle.
import {
	AutoModelForCausalLM,
	AutoTokenizer,
	InterruptableStoppingCriteria,
	TextStreamer,
	env
} from '@huggingface/transformers';
import type { WorkerInbound, WorkerOutbound } from './rewrite.js';

type InitMsg = Extract<WorkerInbound, { type: 'init' }>;
type GenerateMsg = Extract<WorkerInbound, { type: 'generate' }>;

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModelForCausalLM.from_pretrained>> | null = null;

const stopping = new InterruptableStoppingCriteria();
let currentId = 0;
let cancelledThrough = 0;
let queue = Promise.resolve();

const post = (msg: WorkerOutbound) => self.postMessage(msg);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function init({ model: id, revision, cacheKey }: InitMsg) {
	try {
		env.cacheKey = cacheKey;
		tokenizer = await AutoTokenizer.from_pretrained(id, { revision });
		model = await AutoModelForCausalLM.from_pretrained(id, {
			revision,
			device: 'webgpu',
			dtype: 'q4',
			progress_callback: (info) => {
				if (info.status === 'progress_total')
					post({ type: 'progress', fraction: info.progress / 100 });
			}
		});
		post({ type: 'ready' });
	} catch (e) {
		post({ type: 'error', message: errorMessage(e) });
	}
}

async function generate({ id, messages, maxNewTokens }: GenerateMsg) {
	// Cancelled while waiting behind the previous generation.
	if (id <= cancelledThrough) return post({ type: 'done', id });
	currentId = id;
	stopping.reset();
	try {
		const inputs = tokenizer!.apply_chat_template(messages, {
			add_generation_prompt: true,
			return_dict: true
		}) as Record<string, unknown>;
		const streamer = new TextStreamer(tokenizer!, {
			skip_prompt: true,
			skip_special_tokens: true,
			callback_function: (text: string) => post({ type: 'token', id, text })
		});
		await model!.generate({
			...inputs,
			max_new_tokens: maxNewTokens,
			do_sample: false,
			repetition_penalty: 1.05,
			streamer,
			stopping_criteria: stopping
		} as never);
		post({ type: 'done', id });
	} catch (e) {
		post({ type: 'error', id, message: errorMessage(e) });
	}
}

self.onmessage = ({ data }: MessageEvent<WorkerInbound>) => {
	if (data.type === 'init') void init(data);
	else if (data.type === 'generate') queue = queue.then(() => generate(data));
	else if (data.type === 'cancel') {
		cancelledThrough = Math.max(cancelledThrough, data.id);
		if (data.id === currentId) stopping.interrupt();
	}
};
