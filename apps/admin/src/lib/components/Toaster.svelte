<script lang="ts">
	import { CircleCheck, CircleAlert, X } from '@lucide/svelte';
	import { dismiss, layers, toasts } from '#lib/toast.svelte.js';

	let { inDrawer = false }: { inDrawer?: boolean } = $props();
	const active = $derived(layers.drawers > 0 === inDrawer);
</script>

{#if active}
	<div
		class="fixed right-6 bottom-6 z-50 flex w-96 max-w-[calc(100%-3rem)] flex-col gap-2"
		aria-live="polite"
	>
		{#each toasts as t (t.id)}
			<div
				role={t.tone === 'error' ? 'alert' : 'status'}
				class="flex items-start gap-2.5 rounded-lg px-4 py-3 text-sm text-white shadow-pop {t.tone ===
				'error'
					? 'bg-red-700'
					: 'bg-gray-900'}"
			>
				{#if t.tone === 'error'}<CircleAlert size={17} class="mt-px shrink-0" />{:else}<CircleCheck
						size={17}
						class="mt-px shrink-0 text-emerald-300"
					/>{/if}
				<span class="flex-1">{t.text}</span>
				<button
					type="button"
					class="opacity-70 hover:opacity-100"
					onclick={() => dismiss(t.id)}
					aria-label="Dismiss"
				>
					<X size={15} />
				</button>
			</div>
		{/each}
	</div>
{/if}
