<script lang="ts" module>
	// marked + DOMPurify (~75 kB) load on first preview instead of with the dashboard and
	// integrations pages. Provider content is untrusted: sanitize, and open every link in a
	// new tab (hook registered once).
	let libs: Promise<{
		marked: typeof import('marked').marked;
		purify: typeof import('dompurify').default;
	}> | null = null;
	function loadLibs() {
		return (libs ??= Promise.all([import('marked'), import('dompurify')]).then(
			([{ marked }, { default: purify }]) => {
				purify.addHook('afterSanitizeAttributes', (node) => {
					if (node.tagName === 'A') {
						node.setAttribute('target', '_blank');
						node.setAttribute('rel', 'noreferrer');
					}
				});
				return { marked, purify };
			}
		));
	}
</script>

<script lang="ts">
	import { ExternalLink, LoaderCircle } from '@lucide/svelte';
	import Modal from '#lib/components/ui/Modal.svelte';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import { api } from '#lib/api.js';
	import type { IntegrationItemDTO } from '#lib/types.js';

	interface ItemPreview {
		format: 'html' | 'markdown';
		body: string | null;
	}

	let { open = $bindable(false), item }: { open?: boolean; item: IntegrationItemDTO | null } =
		$props();

	let html = $state<string | null>(null);
	let loading = $state(false);
	let failed = $state<string | null>(null);

	const PROVIDER_NAME: Record<string, string> = { github: 'GitHub', linear: 'Linear' };

	$effect(() => {
		if (!open || !item) return;
		const id = item.id;
		html = null;
		failed = null;
		loading = true;
		Promise.all([api<ItemPreview>(`/api/integrations/items/${id}/preview`), loadLibs()])
			.then(([p, { marked, purify }]) => {
				if (item?.id !== id) return;
				const raw = p.body
					? p.format === 'markdown'
						? (marked.parse(p.body, { async: false, gfm: true, breaks: true }) as string)
						: p.body
					: '';
				html = purify.sanitize(raw);
			})
			.catch((e: Error) => {
				if (item?.id === id) failed = e.message;
			})
			.finally(() => {
				if (item?.id === id) loading = false;
			});
	});
</script>

<Modal
	bind:open
	title={item?.title ?? ''}
	description={[item?.subtitle, item?.state].filter(Boolean).join(' · ')}
	size="lg"
>
	{#snippet icon()}<BrandIcon name={item?.provider ?? ''} class="size-5" />{/snippet}
	{#if loading}
		<p class="flex items-center gap-2 text-sm text-muted">
			<LoaderCircle class="size-4 animate-spin" /> Loading description…
		</p>
	{:else if failed}
		<p class="text-sm text-red-600">{failed}</p>
	{:else if html}
		<div class="prose prose-sm max-w-none break-words dark:prose-invert">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
			{@html html}
		</div>
	{:else}
		<p class="text-sm text-muted italic">No description.</p>
	{/if}
	{#snippet footer()}
		<button class="ml-auto btn-outline" onclick={() => (open = false)}>Close</button>
		{#if item}
			<a class="btn-primary" href={item.url} target="_blank" rel="noreferrer"
				>Open in {PROVIDER_NAME[item.provider] ?? 'app'} <ExternalLink class="size-3.5" /></a
			>
		{/if}
	{/snippet}
</Modal>
