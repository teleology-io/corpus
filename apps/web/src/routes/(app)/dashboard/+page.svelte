<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import {
		CircleCheck,
		History,
		ListTodo,
		Pill,
		ArrowUp,
		ArrowDown,
		Minus,
		CalendarDays,
		Bell,
		Check,
		GitPullRequest,
		CircleDot,
		Eye,
		Sunrise,
		Plus,
		AtSign
	} from '@lucide/svelte';
	import TaskList from '#lib/components/dashboard/TaskList.svelte';
	import Icon from '#lib/components/ui/Icon.svelte';
	import AvatarStack from '#lib/components/ui/AvatarStack.svelte';
	import BrandIcon from '#lib/components/ui/BrandIcon.svelte';
	import EmptyState from '#lib/components/ui/EmptyState.svelte';
	import { api } from '#lib/api.js';
	import { attempt, toast } from '#lib/stores/toast.svelte.js';
	import { formatDay, formatTime, tint } from '#lib/calendar.js';
	import type { DoseDTO, IntegrationItemDTO } from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const tz = $derived(data.user.timezone);

	let now = $state(new Date());
	$effect(() => {
		const t = setInterval(() => (now = new Date()), 60_000);
		return () => clearInterval(t);
	});

	const greeting = $derived.by(() => {
		const h = Number(
			new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(now)
		);
		return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
	});

	const delta = $derived(data.stats.completedToday - data.stats.completedYesterday);

	/** Doses + reminders merged into one "take / do" timeline. */
	const nudges = $derived(
		[
			...data.today.doses.map((d) => ({ kind: 'dose' as const, at: d.at, dose: d })),
			...data.today.reminders.map((r) => ({
				kind: 'reminder' as const,
				at: r.at,
				title: r.title,
				id: r.reminderId
			}))
		].sort((a, b) => a.at.localeCompare(b.at))
	);

	const groups = $derived.by(() => {
		const by = (k: string) => data.items.filter((i) => i.kind === k);
		return [
			{ key: 'review_request', label: 'Review requests', icon: Eye, items: by('review_request') },
			{
				key: 'pull_request',
				label: 'Your pull requests',
				icon: GitPullRequest,
				items: by('pull_request')
			},
			{ key: 'issue', label: 'Assigned issues', icon: CircleDot, items: by('issue') }
		].filter((g) => g.items.length);
	});

	async function logDose(d: DoseDTO) {
		const status = d.status === 'taken' ? null : 'taken';
		await attempt(() => api('/api/doses', { body: { cycleId: d.cycleId, at: d.at, status } }));
		if (status) toast(`${d.name} — taken`, { tone: 'success' });
		await refreshAll();
	}

	const isPast = (iso: string) => new Date(iso) < now;
	const isNow = (start: string, end: string) => new Date(start) <= now && now < new Date(end);
	const itemMeta = (i: IntegrationItemDTO) => [i.subtitle, i.state].filter(Boolean).join(' · ');
</script>

<svelte:head><title>Dashboard · Corpus</title></svelte:head>

<div class="space-y-6 p-4 lg:p-8">
	<div class="flex flex-wrap items-end gap-3">
		<div>
			<h2 class="text-2xl font-bold tracking-tight">{greeting}, {data.user.name.split(' ')[0]}</h2>
			<p class="mt-0.5 text-sm text-muted">
				{formatDay(data.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
			</p>
		</div>
		<div class="ml-auto flex gap-2">
			<a href="/calendar" class="btn-outline"><CalendarDays class="size-4" /> Open calendar</a>
			<a href="/cycles" class="btn-outline"><Bell class="size-4" /> Reminders</a>
		</div>
	</div>

	<!-- stats -->
	<div class="grid grid-cols-2 gap-4 xl:grid-cols-4">
		<div class="card p-4">
			<div class="flex items-center gap-2 text-xs font-medium text-muted">
				<CircleCheck class="size-4 text-primary-500" /> Completed today
			</div>
			<p class="mt-2 text-3xl font-bold tracking-tight">{data.stats.completedToday}</p>
			<p class="mt-1 flex items-center gap-1 text-xs text-muted">
				{#if delta > 0}<ArrowUp class="size-3.5 text-emerald-600" /><span
						>{delta} more than yesterday</span
					>
				{:else if delta < 0}<ArrowDown class="size-3.5 text-amber-600" /><span
						>{-delta} fewer than yesterday</span
					>
				{:else}<Minus class="size-3.5" /><span>Same as yesterday</span>{/if}
			</p>
		</div>
		<div class="card p-4">
			<div class="flex items-center gap-2 text-xs font-medium text-muted">
				<History class="size-4 text-primary-500" /> Completed yesterday
			</div>
			<p class="mt-2 text-3xl font-bold tracking-tight">{data.stats.completedYesterday}</p>
			<p class="mt-1 text-xs text-muted">tasks finished</p>
		</div>
		<div class="card p-4">
			<div class="flex items-center gap-2 text-xs font-medium text-muted">
				<ListTodo class="size-4 text-primary-500" /> Still to do today
			</div>
			<p class="mt-2 text-3xl font-bold tracking-tight">{data.stats.openToday}</p>
			<p class="mt-1 text-xs text-muted">
				{data.stats.eventsToday} scheduled appointment{data.stats.eventsToday === 1 ? '' : 's'}
			</p>
		</div>
		<div class="card p-4">
			<div class="flex items-center gap-2 text-xs font-medium text-muted">
				<Pill class="size-4 text-primary-500" /> Doses today
			</div>
			<p class="mt-2 text-3xl font-bold tracking-tight">
				{data.stats.doses.taken}<span class="text-lg font-semibold text-muted"
					>/{data.stats.doses.total}</span
				>
			</p>
			<p class="mt-1 text-xs text-muted">
				{data.stats.doses.total
					? data.stats.doses.taken === data.stats.doses.total
						? 'All taken'
						: 'taken so far'
					: 'None scheduled'}
			</p>
		</div>
	</div>

	<div class="grid gap-4 xl:grid-cols-3">
		<!-- tasks -->
		<section class="card p-4">
			<div class="mb-1 flex items-center justify-between">
				<h3 class="font-semibold">Today's tasks</h3>
				<span class="text-xs text-muted">{data.stats.openToday} open</span>
			</div>
			<TaskList tasks={data.today.tasks} {tz} dueDate={data.date} />
		</section>

		<!-- schedule -->
		<section class="card p-4">
			<div class="mb-3 flex items-center justify-between">
				<h3 class="font-semibold">Schedule</h3>
				<a href="/calendar" class="text-xs font-medium text-primary-600 hover:underline">View all</a
				>
			</div>
			{#if data.today.events.length}
				<ol class="relative space-y-2 border-l border-line pl-4">
					{#each data.today.events as e (e.key)}
						<li class="relative">
							<span
								class="absolute top-3 -left-[21px] size-2.5 rounded-full ring-4 ring-surface"
								style:background={isPast(e.end) ? '#d1d5db' : e.color}
							></span>
							<a
								href="/calendar?date={data.date}&event={e.eventId}"
								class="block rounded-lg border px-3 py-2 transition-colors {isPast(e.end)
									? 'opacity-60'
									: ''}"
								style:background={tint(e.color, isNow(e.start, e.end) ? 0.12 : 0.05)}
								style:border-color={tint(e.color, 0.35)}
							>
								<div class="flex items-center gap-2">
									<span style:color={e.color}
										><Icon name={e.category?.icon ?? 'calendar'} class="size-3.5" /></span
									>
									<span class="flex-1 truncate text-sm font-medium">{e.title}</span>
									{#if isNow(e.start, e.end)}<span
											class="chip bg-primary-500 text-[10px] text-white">Now</span
										>{/if}
								</div>
								<div class="mt-1 flex items-center justify-between gap-2">
									<span class="text-xs text-muted"
										>{e.allDay
											? 'All day'
											: `${formatTime(e.start, tz)} - ${formatTime(e.end, tz)}`}</span
									>
									<AvatarStack people={e.attendees} size={18} />
								</div>
							</a>
						</li>
					{/each}
				</ol>
			{:else}
				<EmptyState title="No appointments today" body="Your calendar is clear.">
					{#snippet icon()}<CalendarDays class="size-5" />{/snippet}
					{#snippet action()}<a href="/calendar" class="btn-outline h-8 text-xs"
							><Plus class="size-3.5" /> Schedule something</a
						>{/snippet}
				</EmptyState>
			{/if}
		</section>

		<!-- reminders & doses -->
		<section class="card p-4">
			<div class="mb-3 flex items-center justify-between">
				<h3 class="font-semibold">Reminders</h3>
				<a href="/cycles" class="text-xs font-medium text-primary-600 hover:underline">Manage</a>
			</div>
			{#if data.cycles.length}
				<div class="mb-3 flex flex-wrap gap-1.5">
					{#each data.cycles as c (c.id)}
						<a
							href="/cycles/{c.id}"
							class="chip"
							style:background={tint(c.color, 0.1)}
							style:color={c.color}
						>
							<Pill class="size-3" />{c.name} ·
							{#if c.phase.status === 'on' || c.phase.status === 'off'}{c.phase.status}
								{c.phase.dayOfPhase}/{c.phase.phaseLength}{:else}{c.phase.status.replace(
									'_',
									' '
								)}{/if}
						</a>
					{/each}
				</div>
			{/if}
			<ul class="space-y-1.5">
				{#each nudges as n (n.kind + n.at + (n.kind === 'dose' ? n.dose.cycleId : n.id))}
					<li
						class="flex items-center gap-3 rounded-lg px-2 py-1.5 {isPast(n.at)
							? ''
							: 'bg-canvas/60'}"
					>
						<span class="w-16 shrink-0 text-xs font-medium text-muted">{formatTime(n.at, tz)}</span>
						{#if n.kind === 'dose'}
							<span style:color={n.dose.color}><Pill class="size-4" /></span>
							<span class="min-w-0 flex-1">
								<span
									class="block truncate text-sm {n.dose.status === 'taken'
										? 'text-gray-400 line-through'
										: ''}">{n.dose.name}</span
								>
								{#if n.dose.doseLabel}<span class="block truncate text-[11px] text-muted"
										>{n.dose.doseLabel}</span
									>{/if}
							</span>
							<button
								class="btn h-7 px-2.5 text-xs {n.dose.status === 'taken'
									? 'bg-emerald-50 text-emerald-700'
									: isPast(n.at)
										? 'bg-primary-500 text-white hover:bg-primary-600'
										: 'border border-line text-ink hover:bg-canvas'}"
								onclick={() => logDose(n.dose)}
							>
								{#if n.dose.status === 'taken'}<Check class="size-3.5" /> Taken{:else}Take{/if}
							</button>
						{:else}
							<span class="text-amber-500"><Bell class="size-4" /></span>
							<span class="flex-1 truncate text-sm">{n.title}</span>
						{/if}
					</li>
				{:else}
					<li>
						<EmptyState
							title="No reminders today"
							body="Set up a reminder or cycle — e.g. “Take pills” at 8am."
						>
							{#snippet icon()}<Bell class="size-5" />{/snippet}
						</EmptyState>
					</li>
				{/each}
			</ul>
		</section>
	</div>

	<div class="grid gap-4 xl:grid-cols-3">
		<!-- integrations -->
		<section class="card p-4 xl:col-span-2">
			<div class="mb-3 flex items-center justify-between">
				<h3 class="flex items-center gap-2 font-semibold">Work queue</h3>
				<a href="/integrations" class="text-xs font-medium text-primary-600 hover:underline"
					>Integrations</a
				>
			</div>
			{#if groups.length || data.slackThreads.length}
				<div class="grid gap-4 md:grid-cols-2">
					{#if data.slackThreads.length}
						<div>
							<p class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted">
								<BrandIcon name="slack" class="size-3.5" />
								Slack threads
								<span class="chip bg-canvas text-[10px]">{data.slackThreads.length} unread</span>
							</p>
							<ul class="divide-y divide-line/70">
								{#each data.slackThreads.slice(0, 6) as t (t.id)}
									<li>
										<a
											href="/integrations/slack?thread={t.id}"
											class="flex items-start gap-2.5 py-2 hover:bg-canvas/60"
										>
											{#if t.mentioned}<AtSign
													class="mt-0.5 size-4 shrink-0 text-primary-500"
												/>{:else}<BrandIcon
													name="slack"
													class="mt-0.5 size-4 shrink-0 text-ink"
												/>{/if}
											<span class="min-w-0">
												<span class="block truncate text-sm">{t.preview ?? 'New replies'}</span>
												<span class="block truncate text-[11px] text-muted"
													>{t.channelName ?? 'Thread'} · {t.replyCount}
													{t.replyCount === 1 ? 'reply' : 'replies'}</span
												>
											</span>
										</a>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#each groups as g (g.key)}
						<div>
							<p class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted">
								<g.icon class="size-3.5" />
								{g.label} <span class="chip bg-canvas text-[10px]">{g.items.length}</span>
							</p>
							<ul class="divide-y divide-line/70">
								{#each g.items.slice(0, 6) as i (i.id)}
									<li>
										<a
											href={i.url}
											target="_blank"
											rel="noreferrer"
											class="flex items-start gap-2.5 py-2 hover:bg-canvas/60"
										>
											<BrandIcon name={i.provider} class="mt-0.5 size-4 shrink-0 text-ink" />
											<span class="min-w-0">
												<span class="block truncate text-sm">{i.title}</span>
												<span class="block truncate text-[11px] text-muted">{itemMeta(i)}</span>
											</span>
										</a>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				</div>
			{:else}
				<EmptyState
					title="No open work items"
					body="Connect GitHub, Linear or Slack to see review requests, PRs, issues and unread threads here — updated live."
				>
					{#snippet icon()}<GitPullRequest class="size-5" />{/snippet}
					{#snippet action()}<a href="/integrations" class="btn-primary h-8 text-xs"
							>Connect integrations</a
						>{/snippet}
				</EmptyState>
			{/if}
		</section>

		<!-- tomorrow -->
		<section class="card p-4">
			<div class="mb-3 flex items-center justify-between">
				<h3 class="flex items-center gap-2 font-semibold">
					<Sunrise class="size-4 text-amber-500" /> Tomorrow
				</h3>
				<span class="text-xs text-muted"
					>{formatDay(data.tomorrowDate, {
						weekday: 'short',
						month: 'short',
						day: 'numeric'
					})}</span
				>
			</div>
			{#if data.tomorrow.events.length}
				<p class="mb-1 text-[11px] font-semibold tracking-wide text-gray-400 uppercase">
					Appointments
				</p>
				<ul class="mb-3 space-y-1">
					{#each data.tomorrow.events as e (e.key)}
						<li class="flex items-center gap-2 text-sm">
							<span class="size-2 shrink-0 rounded-full" style:background={e.color}></span>
							<span class="w-16 shrink-0 text-xs text-muted"
								>{e.allDay ? 'All day' : formatTime(e.start, tz)}</span
							>
							<span class="truncate">{e.title}</span>
						</li>
					{/each}
				</ul>
			{/if}
			{#if data.tomorrow.doses.length || data.tomorrow.reminders.length}
				<p class="mb-1 text-[11px] font-semibold tracking-wide text-gray-400 uppercase">
					Reminders
				</p>
				<ul class="mb-3 space-y-1">
					{#each data.tomorrow.doses as d (d.cycleId + d.at)}
						<li class="flex items-center gap-2 text-sm">
							<Pill class="size-3.5 shrink-0" style="color: {d.color}" /><span
								class="w-16 shrink-0 text-xs text-muted">{formatTime(d.at, tz)}</span
							><span class="truncate">{d.name}</span>
						</li>
					{/each}
					{#each data.tomorrow.reminders as r (r.reminderId + r.at)}
						<li class="flex items-center gap-2 text-sm">
							<Bell class="size-3.5 shrink-0 text-amber-500" /><span
								class="w-16 shrink-0 text-xs text-muted">{formatTime(r.at, tz)}</span
							><span class="truncate">{r.title}</span>
						</li>
					{/each}
				</ul>
			{/if}
			<p class="mb-1 text-[11px] font-semibold tracking-wide text-gray-400 uppercase">Tasks</p>
			<TaskList
				tasks={data.tomorrow.tasks}
				{tz}
				dueDate={data.tomorrowDate}
				placeholder="Add a task for tomorrow…"
				emptyText="No tasks yet."
			/>
		</section>
	</div>
</div>
