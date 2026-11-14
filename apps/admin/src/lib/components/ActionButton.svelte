<script lang="ts">
	import { enhance } from '$app/forms';
	import type { Snippet } from 'svelte';
	import { toast } from '#lib/toast.svelte.js';

	/** One-click, non-destructive form action (still audited server-side). */
	let {
		action,
		success,
		fields = {},
		primary = false,
		label,
		onsuccess,
		children
	}: {
		action: string;
		/** Toast shown once the server accepts the action. */
		success: string;
		fields?: Record<string, string>;
		primary?: boolean;
		/** Accessible name when the visible text is ambiguous (e.g. repeated per row). */
		label?: string;
		/** Runs after the success toast, e.g. to start watching for a result. */
		onsuccess?: () => void;
		children: Snippet;
	} = $props();

	let busy = $state(false);
</script>

<form
	method="POST"
	{action}
	class="inline"
	use:enhance={() => {
		busy = true;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'failure' || result.type === 'error') {
				const msg =
					result.type === 'failure'
						? String(result.data?.error ?? '')
						: (result.error?.message ?? '');
				toast(msg || 'That didn’t work. Nothing was changed.', 'error');
				return;
			}
			toast(success);
			onsuccess?.();
			await update({ invalidateAll: true });
		};
	}}
>
	{#each Object.entries(fields) as [name, value] (name)}
		<input type="hidden" {name} {value} />
	{/each}
	<button
		type="submit"
		class={primary ? 'btn-primary btn' : 'btn'}
		disabled={busy}
		aria-label={label}
	>
		{@render children()}
	</button>
</form>
