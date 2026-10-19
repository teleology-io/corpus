<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		description,
		icon,
		size = 'md',
		children,
		footer
	}: {
		open?: boolean;
		title: string;
		description?: string;
		icon?: Snippet;
		size?: 'sm' | 'md' | 'lg' | 'xl';
		children: Snippet;
		footer?: Snippet;
	} = $props();

	const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]" />
		<Dialog.Content
			class="fixed top-1/2 left-1/2 z-50 flex max-h-[90dvh] w-[calc(100%-2rem)] {widths[
				size
			]} -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-surface shadow-pop outline-none"
		>
			<div class="flex items-start gap-3 border-b border-line px-5 py-4">
				{#if icon}
					<div
						class="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line text-ink"
					>
						{@render icon()}
					</div>
				{/if}
				<div class="min-w-0 flex-1">
					<Dialog.Title class="text-base font-semibold text-ink">{title}</Dialog.Title>
					{#if description}
						<Dialog.Description class="mt-0.5 text-xs text-muted">{description}</Dialog.Description>
					{/if}
				</div>
				<Dialog.Close class="-mr-2 btn-icon size-8" aria-label="Close"
					><X class="size-4" /></Dialog.Close
				>
			</div>
			<div class="min-h-0 flex-1 scrollbar-thin overflow-y-auto px-5 py-4">
				{@render children()}
			</div>
			{#if footer}
				<div class="flex items-center gap-2 border-t border-line px-5 py-3.5">
					{@render footer()}
				</div>
			{/if}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
