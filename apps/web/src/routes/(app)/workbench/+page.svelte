<script lang="ts">
	import { mount, onMount, unmount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { SquareTerminal } from '@lucide/svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { mountWrx } from '#lib/wrx/app.js';
	import WorkbenchSidebar, { type WbSidebarData } from '#lib/wrx/WorkbenchSidebar.svelte';
	import '#lib/wrx/wrx.css';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let root = $state<HTMLDivElement>();

	let wrx: ReturnType<typeof mountWrx> | undefined;

	// WRX renders its markup as strings; the projects sidebar is Svelte (same parts as the main
	// sidebar), mounted into the host element WRX leaves for it and fed WRX's snapshot each render.
	const side = $state<{ data: WbSidebarData | null }>({ data: null });
	let sideHost: HTMLElement | null = null;
	let sideApp: ReturnType<typeof mount> | undefined;
	let lastSide = '';

	function syncSidebar(host: HTMLElement | null, data: WbSidebarData) {
		const json = JSON.stringify(data);
		if (json !== lastSide) {
			lastSide = json;
			side.data = data;
		}
		if (host === sideHost) return;
		if (sideApp) void unmount(sideApp);
		sideApp = undefined;
		sideHost = host;
		if (!host) return;
		sideApp = mount(WorkbenchSidebar, {
			target: host,
			props: {
				get data() {
					return side.data!;
				},
				onchoose: (id) => wrx?.chooseWorkspace(id),
				onaction: (action) => wrx?.action(action),
				ondelete: (id) => wrx?.deleteProject(id)
			}
		});
	}

	onMount(() => {
		if (!root) return;
		wrx = mountWrx(root, { onSidebar: syncSidebar });
		return () => {
			if (sideApp) void unmount(sideApp);
			wrx?.();
		};
	});

	// Same-page navigations (⌘K results, dashboard links) don't remount; hand the new query over.
	afterNavigate((nav) => {
		if (nav.type !== 'enter' && nav.from?.route.id === nav.to?.route.id)
			wrx?.navigate(page.url.searchParams);
	});
</script>

{#if data.enabled}
	<div class="wrx" bind:this={root}></div>
{:else}
	<div class="p-8">
		<EmptyState
			title="Workbench is off for this account"
			body="Workbench runs Git, Claude Code, Codex and Colima on the server as its OS user. Add your email to WRX_ALLOWED_EMAILS to enable it."
		>
			{#snippet icon()}<SquareTerminal class="size-5" />{/snippet}
		</EmptyState>
	</div>
{/if}
