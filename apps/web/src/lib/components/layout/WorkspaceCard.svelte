<script lang="ts">
	import { page } from '$app/state';
	import { goto, refreshAll } from '$app/navigation';
	import { DropdownMenu } from 'bits-ui';
	import { Check, ChevronsUpDown, Gem, Plus } from '@lucide/svelte';
	import { authClient } from '@corpus/auth/client';
	import { attempt } from '#lib/stores/toast.svelte.js';

	const workspaces = $derived(page.data.workspaces ?? []);
	const current = $derived(workspaces.find((w) => w.id === page.data.workspaceId));
	const kindLabel = {
		personal: 'Personal workspace',
		org: 'Organization',
		family: 'Family'
	} as Record<string, string>;

	async function switchTo(id: string) {
		await attempt(async () => {
			const res = await authClient.organization.setActive({ organizationId: id });
			if (res.error) throw new Error(res.error.message);
		}, 'Could not switch workspace');
		await refreshAll();
	}
</script>

<div class="rounded-xl border border-line bg-canvas p-3.5">
	<div class="flex items-start gap-2.5">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-500 text-white"
		>
			<Gem class="size-4" />
		</span>
		<div class="min-w-0">
			<p class="truncate text-sm font-semibold text-ink">{current?.name ?? 'Workspace'}</p>
			<p class="text-[11px] leading-snug text-muted">
				{current ? kindLabel[current.kind ?? 'org'] : ''} · {workspaces.length} workspace{workspaces.length ===
				1
					? ''
					: 's'}
			</p>
		</div>
	</div>
	<DropdownMenu.Root>
		<DropdownMenu.Trigger class="mt-3 btn-primary h-8 w-full text-xs">
			Switch workspace <ChevronsUpDown class="size-3.5" />
		</DropdownMenu.Trigger>
		<DropdownMenu.Portal>
			<DropdownMenu.Content class="menu w-56" side="top" sideOffset={8}>
				{#each workspaces as w (w.id)}
					<DropdownMenu.Item class="menu-item" onSelect={() => switchTo(w.id)}>
						<span class="flex-1 truncate">{w.name}</span>
						<span class="text-[10px] text-muted capitalize">{w.kind}</span>
						{#if w.id === current?.id}<Check class="size-3.5 text-primary-500" />{/if}
					</DropdownMenu.Item>
				{/each}
				<DropdownMenu.Separator class="my-1 h-px bg-line" />
				<DropdownMenu.Item
					class="menu-item text-primary-600"
					onSelect={() => goto('/teams?create=1')}
				>
					<Plus class="size-3.5" /> New team or family
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Portal>
	</DropdownMenu.Root>
</div>
