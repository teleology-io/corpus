<script lang="ts">
	import { fly } from 'svelte/transition';
	import { Bell, CircleCheck, CircleAlert, X } from '@lucide/svelte';
	import { dismiss, dismissAll, toasts } from '#lib/stores/toast.svelte.js';
</script>

<!-- Sticky toasts can pile up, so the stack scrolls and offers a way to clear it. -->
<div
	class="pointer-events-none fixed right-2 bottom-2 z-[60] flex max-h-[calc(100dvh-1rem)] w-84 scrollbar-thin flex-col gap-2 overflow-y-auto p-2"
>
	{#if toasts.length > 1}
		<button
			class="pointer-events-auto shrink-0 self-end rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium text-muted shadow-pop hover:text-ink"
			onclick={dismissAll}
		>
			Clear all
		</button>
	{/if}
	{#each toasts as t (t.id)}
		<div
			transition:fly={{ x: 24, duration: 180 }}
			class="pointer-events-auto flex shrink-0 items-start gap-3 rounded-xl border border-line bg-surface p-3 shadow-pop"
			role="status"
		>
			<span
				class="mt-0.5 shrink-0 {t.tone === 'error'
					? 'text-red-500'
					: t.tone === 'success'
						? 'text-emerald-500'
						: 'text-primary-500'}"
			>
				{#if t.tone === 'error'}<CircleAlert
						class="size-4"
					/>{:else if t.tone === 'success'}<CircleCheck class="size-4" />{:else}<Bell
						class="size-4"
					/>{/if}
			</span>
			<div class="min-w-0 flex-1">
				{#if t.href}
					<a
						href={t.href}
						class="text-sm font-semibold text-ink hover:underline"
						onclick={() => dismiss(t.id)}>{t.title}</a
					>
				{:else}
					<p class="text-sm font-semibold text-ink">{t.title}</p>
				{/if}
				{#if t.body}<p class="mt-0.5 text-xs text-muted">{t.body}</p>{/if}
			</div>
			<button
				class="text-gray-400 hover:text-ink"
				onclick={() => dismiss(t.id)}
				aria-label="Dismiss"
			>
				<X class="size-3.5" />
			</button>
		</div>
	{/each}
</div>
