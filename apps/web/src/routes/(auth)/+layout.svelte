<script lang="ts">
	import Logo from '#lib/components/ui/Logo.svelte';
	import { CalendarDays, Pill, NotebookText, FolderGit2 } from '@lucide/svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const points = [
		{
			icon: CalendarDays,
			title: 'One calendar for everything',
			body: 'Meetings, appointments, reminders and recurring schedules.'
		},
		{
			icon: Pill,
			title: 'Cycles that track themselves',
			body: '6 weeks on, 3 off — dose reminders only when you need them.'
		},
		{
			icon: NotebookText,
			title: 'Notes you write together',
			body: 'A block editor with live collaboration and share links.'
		},
		{
			icon: FolderGit2,
			title: 'Your work, in one place',
			body: 'GitHub reviews and Linear issues right on your dashboard.'
		}
	];
</script>

<div class="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
	<div class="flex flex-col px-6 py-8 sm:px-12">
		<Logo />
		<div class="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
			{@render children()}
		</div>
	</div>
	<div class="relative hidden overflow-hidden bg-primary-500 lg:block">
		<div
			class="absolute inset-0 opacity-20"
			style="background-image: radial-gradient(circle at 1px 1px, white 1px, transparent 0); background-size: 22px 22px"
		></div>
		<div class="relative flex h-full flex-col justify-center px-16 text-white">
			<h2 class="max-w-md text-3xl leading-tight font-bold">
				Plan your days, your health and your work — together.
			</h2>
			<ul class="mt-10 space-y-6">
				{#each points as p (p.title)}
					<li class="flex gap-4">
						<span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/15"
							><p.icon class="size-5" /></span
						>
						<span>
							<span class="block font-semibold">{p.title}</span>
							<span class="block text-sm text-white/80">{p.body}</span>
						</span>
					</li>
				{/each}
			</ul>
		</div>
	</div>
</div>
