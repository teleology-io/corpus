<script lang="ts">
	import { LoaderCircle, SendHorizontal } from '@lucide/svelte';

	let {
		placeholder,
		onsend,
		disabled = false
	}: {
		placeholder: string;
		/** Resolves true when Slack confirmed the post (the draft is then cleared). */
		onsend: (text: string) => Promise<boolean>;
		disabled?: boolean;
	} = $props();

	let draft = $state('');
	let sending = $state(false);

	async function send() {
		const text = draft.trim();
		if (!text || sending || disabled) return;
		sending = true;
		const ok = await onsend(text);
		sending = false;
		if (ok) draft = '';
	}
</script>

<form
	class="border-t border-line p-3"
	onsubmit={(e) => {
		e.preventDefault();
		void send();
	}}
>
	<div
		class="flex items-end gap-2 rounded-xl border border-line bg-surface p-2 focus-within:border-primary-500"
	>
		<textarea
			class="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none"
			rows="1"
			{placeholder}
			{disabled}
			maxlength={12000}
			bind:value={draft}
			onkeydown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
					e.preventDefault();
					void send();
				}
			}}></textarea>
		<button
			class="btn-primary h-9 px-3"
			disabled={sending || disabled || !draft.trim()}
			aria-label="Send"
		>
			{#if sending}<LoaderCircle class="size-4 animate-spin" />{:else}<SendHorizontal
					class="size-4"
				/>{/if}
		</button>
	</div>
	<p class="mt-1.5 px-1 text-[11px] text-muted">
		Posts to Slack as you · *bold* _italic_ `code` work · Enter to send, Shift+Enter for a new line
	</p>
</form>
