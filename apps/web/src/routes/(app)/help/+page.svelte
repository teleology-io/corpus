<script lang="ts">
	import {
		CalendarDays,
		Pill,
		NotebookText,
		Users,
		Puzzle,
		Bell,
		LayoutGrid
	} from '@lucide/svelte';

	const topics = [
		{
			icon: LayoutGrid,
			title: 'Dashboard',
			items: [
				[
					'What counts as “today”?',
					'Everything is calculated in your time zone (Settings → Profile). Tasks due today, overdue tasks and tasks without a date all appear in Today’s tasks.'
				],
				[
					'Where do the stats come from?',
					'Completed today/yesterday count tasks you checked off in those local days, including tasks imported from GitHub or Linear.'
				]
			]
		},
		{
			icon: CalendarDays,
			title: 'Calendar',
			items: [
				[
					'Create quickly',
					'Drag on an empty part of the week grid to create a schedule for that time, or double-click a day in the month view.'
				],
				[
					'Move and resize',
					'Drag an event to move it; drag its bottom edge to change the end time. For repeating events you choose this event, following events, or all.'
				],
				[
					'Subscribe elsewhere',
					'Use “Subscribe” to copy a private .ics link for Google Calendar, Apple Calendar or Outlook. “Export” downloads a one-off file.'
				],
				[
					'Deleted schedules',
					'Deleted events go to Deleted Schedule, where you can restore them or remove them permanently.'
				]
			]
		},
		{
			icon: Pill,
			title: 'Cycles',
			items: [
				[
					'On/off schedules',
					'A cycle like “6 weeks on, 3 weeks off” only schedules doses during on weeks. Off weeks are quiet — no reminders.'
				],
				[
					'Logging doses',
					'Tap Take on the dashboard (or the pill marker in the week view). Doses not logged within 2 hours trigger a “missed dose” notification.'
				],
				['Pausing', 'Pause a cycle to stop reminders without losing its history.']
			]
		},
		{
			icon: NotebookText,
			title: 'Notes',
			items: [
				[
					'Formatting',
					'Type “/” for blocks (headings, to-dos, tables, callouts, code, images) and “@” to mention someone. Select text for the formatting toolbar.'
				],
				[
					'Collaboration',
					'Everyone in the workspace can edit together in real time. Use Share to invite people outside the workspace or publish a link.'
				]
			]
		},
		{
			icon: Users,
			title: 'Teams & families',
			items: [
				[
					'Workspaces',
					'Your personal workspace is private. Create an organization or family from Teams, invite people, then switch workspaces from the card at the bottom of the sidebar.'
				]
			]
		},
		{
			icon: Puzzle,
			title: 'Integrations',
			items: [
				[
					'GitHub & Linear',
					'Integrations are connected to your account (not the workspace). Review requests, your PRs and assigned issues are polled about every minute and appear on your dashboard.'
				]
			]
		},
		{
			icon: Bell,
			title: 'Notifications',
			items: [
				[
					'Channels',
					'Choose in-app, push and email per notification type in Settings. Enable push on each device you want alerts on. Quiet hours silence push overnight.'
				]
			]
		}
	];
</script>

<svelte:head><title>Help · Corpus</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-4 p-4 lg:p-8">
	{#each topics as t (t.title)}
		<section class="card p-5">
			<h2 class="flex items-center gap-2 font-semibold">
				<t.icon class="size-4 text-primary-500" />
				{t.title}
			</h2>
			<div class="mt-3 divide-y divide-line">
				{#each t.items as [q, a] (q)}
					<details class="group py-3">
						<summary
							class="cursor-pointer list-none text-sm font-medium group-open:text-primary-600"
							>{q}</summary
						>
						<p class="mt-1.5 text-sm text-muted">{a}</p>
					</details>
				{/each}
			</div>
		</section>
	{/each}
</div>
