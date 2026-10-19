<script lang="ts">
	import NoteSidebar from '#lib/components/notes/NoteSidebar.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<div class="flex h-full">
	<div class="hidden w-64 shrink-0 border-r border-line bg-surface md:block">
		<NoteSidebar tree={data.tree} shared={data.shared} archived={data.archived} />
	</div>
	<div class="min-w-0 flex-1 scrollbar-thin overflow-y-auto">
		{@render children()}
	</div>
</div>
