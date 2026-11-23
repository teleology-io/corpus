<script lang="ts" module>
	export type WbSidebarData = {
		projects: { id: string; name: string }[];
		workspaces: { id: string; name: string; projectId: string; live: boolean }[];
		environments: number;
		workspaceId: string | null;
	};
	export type WbSidebarAction = 'project' | 'environments' | 'computers' | 'settings';
</script>

<script lang="ts">
	import { onMount, type Component, type Snippet } from 'svelte';
	import { DropdownMenu, Tooltip } from 'bits-ui';
	import {
		Box,
		Check,
		CodeXml,
		GitBranch,
		PanelRightClose,
		PanelRightOpen,
		Plug,
		Plus,
		SquareTerminal,
		Trash2
	} from '@lucide/svelte';
	import { workbenchSidebar } from '#lib/stores/sidebar.svelte.js';

	// Mounted by the workbench page into WRX's #wrx-sidebar; `data` is WRX's per-render snapshot.
	let {
		data,
		onchoose,
		onaction,
		ondelete
	}: {
		data: WbSidebarData;
		onchoose: (workspaceId: string) => void;
		onaction: (action: WbSidebarAction) => void;
		ondelete: (projectId: string) => void;
	} = $props();

	onMount(() => workbenchSidebar.init());

	// Compact project menus open on hover (or click/keyboard) and close shortly after the pointer
	// leaves both the tile and the menu.
	let openId = $state<string | null>(null);
	let byHover = false;
	let pressedAt = 0;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;

	function hoverOpen(id: string) {
		clearTimeout(closeTimer);
		if (openId === id) return;
		byHover = true;
		openId = id;
	}
	function hoverClose() {
		if (!byHover) return;
		clearTimeout(closeTimer);
		closeTimer = setTimeout(() => (openId = null), 200);
	}
	function setOpen(id: string, open: boolean) {
		clearTimeout(closeTimer);
		if (open) {
			byHover = false;
			openId = id;
		} else if (openId === id) {
			// A click on a tile its hover already opened keeps it open (and pins it) instead of toggling.
			if (byHover && Date.now() - pressedAt < 400) byHover = false;
			else openId = null;
		}
	}

	const compact = $derived(workbenchSidebar.compact);
	const spaces = (projectId: string) => data.workspaces.filter((w) => w.projectId === projectId);
	const monogram = (name: string) => (name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();

	const bottom: {
		action: WbSidebarAction;
		label: string;
		icon: Component<{ class?: string }>;
	}[] = [
		{ action: 'environments', label: 'Environments', icon: Box },
		{ action: 'computers', label: 'Computers', icon: SquareTerminal },
		{ action: 'settings', label: 'Connections', icon: Plug }
	];

	// Same row treatment as the main sidebar.
	const row = (on: boolean) =>
		`flex h-10 w-full items-center gap-3 rounded-lg text-[13px] font-medium transition-colors ${
			compact ? 'justify-center px-0' : 'px-3'
		} ${on ? 'bg-primary-50 text-primary-600' : 'text-gray-600 hover:bg-canvas hover:text-ink'}`;
</script>

{#snippet tip(label: string, trigger: Snippet<[Record<string, unknown>]>, always = false)}
	<Tooltip.Root disabled={!compact && !always}>
		<Tooltip.Trigger>
			{#snippet child({ props })}{@render trigger(props)}{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Portal>
			<Tooltip.Content
				side="left"
				sideOffset={10}
				class="z-50 rounded-md border border-line bg-surface px-2 py-1 text-xs font-medium text-ink shadow-pop"
			>
				{label}
			</Tooltip.Content>
		</Tooltip.Portal>
	</Tooltip.Root>
{/snippet}

{#snippet liveDot(cls = '')}
	<span class="size-1.5 shrink-0 rounded-full bg-emerald-500 {cls}" aria-hidden="true"></span>
{/snippet}

<Tooltip.Provider delayDuration={150}>
	<div
		class="wb-side flex h-full flex-col bg-surface {compact
			? 'w-16'
			: 'w-[243px] @max-[1100px]:w-[205px]'}"
	>
		<div
			class="flex-1 scrollbar-thin overflow-x-hidden overflow-y-auto pb-2 {compact
				? 'px-2'
				: 'px-2.5'}"
			role="navigation"
			aria-label="Projects"
		>
			<div
				class="my-4 flex items-center text-[10px] font-medium tracking-[1px] text-muted {compact
					? 'justify-center'
					: 'justify-between pr-1 pl-3'}"
			>
				{#if !compact}<span>PROJECTS</span>{/if}
				<span class="flex items-center gap-2">
					{#if !compact}<span>{data.projects.length}</span>{/if}
					{#snippet add(props: Record<string, unknown>)}
						<button
							{...props}
							type="button"
							onclick={() => onaction('project')}
							aria-label="Add project"
							class="flex size-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-canvas hover:text-ink"
						>
							<Plus class="size-4" />
						</button>
					{/snippet}
					{@render tip('Add project', add, true)}
				</span>
			</div>

			{#if !data.projects.length}
				{#if !compact}
					<span class="block px-3 text-[11px] text-muted">Your projects will appear here.</span>
				{/if}
			{:else if compact}
				<ul class="flex flex-col items-center gap-1.5">
					{#each data.projects as p (p.id)}
						{@const list = spaces(p.id)}
						{@const selected = list.some((w) => w.id === data.workspaceId)}
						<li>
							<DropdownMenu.Root bind:open={() => openId === p.id, (o) => setOpen(p.id, o)}>
								<DropdownMenu.Trigger
									aria-label="{p.name} workspaces"
									onpointerenter={(e) => e.pointerType !== 'touch' && hoverOpen(p.id)}
									onpointerleave={hoverClose}
									onpointerdowncapture={() => (pressedAt = Date.now())}
									class="relative flex size-10 items-center justify-center rounded-lg border text-[13px] font-semibold transition-colors data-[state=open]:bg-canvas {selected
										? 'border-primary-200 bg-primary-50 text-primary-600'
										: 'border-line text-gray-600 hover:bg-canvas hover:text-ink'}"
								>
									{monogram(p.name)}
									{#if list.some((w) => w.live)}{@render liveDot('absolute top-1 right-1')}{/if}
								</DropdownMenu.Trigger>
								<DropdownMenu.Portal>
									<DropdownMenu.Content
										class="menu w-56"
										side="left"
										align="start"
										sideOffset={10}
										trapFocus={false}
										preventScroll={false}
										onOpenAutoFocus={(e) => byHover && e.preventDefault()}
										onCloseAutoFocus={(e) => byHover && e.preventDefault()}
										onpointerenter={() => clearTimeout(closeTimer)}
										onpointerleave={hoverClose}
									>
										<div class="flex items-center gap-2 px-2 py-1.5 text-xs font-semibold text-ink">
											<CodeXml class="size-3.5 text-gray-400" />
											<span class="truncate">{p.name}</span>
										</div>
										{#each list as w (w.id)}
											<DropdownMenu.Item class="menu-item" onSelect={() => onchoose(w.id)}>
												<GitBranch class="size-3.5 text-gray-400" />
												<span class="flex-1 truncate">{w.name}</span>
												{#if w.live}{@render liveDot()}{/if}
												{#if w.id === data.workspaceId}<Check
														class="size-3.5 text-primary-500"
													/>{/if}
											</DropdownMenu.Item>
										{:else}
											<span class="block px-2 py-1.5 text-xs text-muted">No workspaces yet.</span>
										{/each}
										<DropdownMenu.Separator class="my-1 h-px bg-line" />
										<DropdownMenu.Item
											class="menu-item text-red-600"
											onSelect={() => ondelete(p.id)}
										>
											<Trash2 class="size-3.5" /> Remove project
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Portal>
							</DropdownMenu.Root>
						</li>
					{/each}
				</ul>
			{:else}
				{#each data.projects as p (p.id)}
					<div class="mt-3 first-of-type:mt-0">
						<div
							class="group flex h-9 items-center gap-2.5 px-3 text-[13px] font-semibold text-ink"
						>
							<CodeXml class="size-4 shrink-0 text-gray-400" />
							<span class="truncate">{p.name}</span>
							<button
								type="button"
								onclick={() => ondelete(p.id)}
								title="Remove project"
								aria-label="Remove project {p.name}"
								class="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-600 focus-visible:opacity-100"
							>
								<Trash2 class="size-3.5" />
							</button>
						</div>
						<ul class="space-y-0.5">
							{#each spaces(p.id) as w (w.id)}
								{@const on = w.id === data.workspaceId}
								<li>
									<button
										type="button"
										onclick={() => onchoose(w.id)}
										aria-current={on ? 'true' : undefined}
										class="{row(on)} pl-7"
									>
										<GitBranch
											class="size-4 shrink-0 {on ? 'text-primary-500' : 'text-gray-400'}"
										/>
										<span class="truncate">{w.name}</span>
										{#if w.live}{@render liveDot('ml-auto')}{/if}
									</button>
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			{/if}
		</div>

		<div class="border-t border-line py-3 {compact ? 'px-2' : 'px-2.5'}">
			<ul class="space-y-0.5">
				{#each bottom as item (item.action)}
					<li>
						{#snippet btn(props: Record<string, unknown>)}
							<button
								{...props}
								type="button"
								onclick={() => onaction(item.action)}
								class={row(false)}
							>
								<span class="relative">
									<item.icon class="size-[18px] text-gray-400" />
									{#if item.action === 'settings' && compact}{@render liveDot(
											'absolute -top-0.5 -right-0.5'
										)}{/if}
								</span>
								<span class={compact ? 'sr-only' : ''}>{item.label}</span>
								{#if !compact && item.action === 'environments'}
									<span class="ml-auto text-xs text-muted">{data.environments}</span>
								{:else if !compact && item.action === 'settings'}
									{@render liveDot('ml-auto')}
								{/if}
							</button>
						{/snippet}
						{@render tip(item.label, btn)}
					</li>
				{/each}
				<li>
					{#snippet toggle(props: Record<string, unknown>)}
						<button
							{...props}
							type="button"
							onclick={() => workbenchSidebar.toggle()}
							aria-pressed={compact}
							aria-label={compact ? 'Expand projects sidebar' : 'Collapse projects sidebar'}
							class={row(false)}
						>
							{#if compact}
								<PanelRightOpen class="size-[18px] text-gray-400" />
							{:else}
								<PanelRightClose class="size-[18px] text-gray-400" />
								<span>Collapse sidebar</span>
							{/if}
						</button>
					{/snippet}
					{@render tip('Expand sidebar', toggle)}
				</li>
			</ul>

			<div
				class="mt-3 flex items-center gap-2.5 border-t border-line pt-3 {compact
					? 'justify-center'
					: 'px-1'}"
			>
				{#snippet local(props: Record<string, unknown>)}
					<span
						{...props}
						class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-canvas text-gray-500"
					>
						<SquareTerminal class="size-4" />
					</span>
				{/snippet}
				{@render tip('Local workbench · on your machine', local)}
				{#if !compact}
					<span class="min-w-0 text-[11px] text-gray-600">
						Local workbench
						<small class="mt-0.5 block text-[9px] text-muted"
							>On your machine. In your control.</small
						>
					</span>
				{/if}
			</div>
		</div>
	</div>
</Tooltip.Provider>
