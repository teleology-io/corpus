<script lang="ts">
	import { format, formatDistanceToNowStrict } from 'date-fns';
	import { MessageSquareReply, Paperclip } from '@lucide/svelte';
	import Avatar from '#lib/components/ui/Avatar.svelte';
	import SlackText from './SlackText.svelte';
	import type { SlackMessageDTO } from '#lib/types.js';

	let {
		m,
		now,
		highlight = false,
		onthread
	}: {
		m: SlackMessageDTO;
		/** Re-render relative times when this ticks */
		now: Date;
		highlight?: boolean;
		/** Shown as "N replies" when the message starts a thread */
		onthread?: (ts: string) => void;
	} = $props();

	const ago = (iso: string) => {
		void now;
		return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
	};
	const size = (n: number | null) =>
		n == null
			? ''
			: n > 1_048_576
				? `${(n / 1_048_576).toFixed(1)} MB`
				: `${Math.max(1, Math.round(n / 1024))} KB`;
</script>

{#if m.system}
	<div class="flex items-baseline gap-1 pl-11 text-xs text-muted [&_div]:text-xs" data-ts={m.ts}>
		<span class="shrink-0 font-medium">{m.author.name}</span>
		<SlackText segments={m.segments} />
	</div>
{:else}
	<div
		class="group flex gap-3 rounded-lg transition-colors {highlight
			? 'bg-amber-50 ring-1 ring-amber-200'
			: ''}"
		data-ts={m.ts}
	>
		<Avatar name={m.author.name} image={m.author.image} size={32} />
		<div class="min-w-0 flex-1">
			<p class="flex items-baseline gap-2">
				<span class="text-sm font-semibold">{m.author.name}</span>
				<span class="text-[11px] text-muted" title={format(new Date(m.at), 'PPpp')}
					>{ago(m.at)}{m.edited && !m.deleted ? ' · edited' : ''}</span
				>
			</p>
			{#if m.deleted}
				<p class="text-sm text-muted italic">This message was deleted.</p>
			{:else}
				<SlackText segments={m.segments} />
				{#each m.files as f, i (i)}
					{#if f.url}
						<a
							href={f.url}
							target="_blank"
							rel="noreferrer"
							class="mt-1 mr-2 inline-flex items-center gap-1 text-xs text-primary-600 hover:underline"
							><Paperclip class="size-3" />{f.name}
							{#if f.size}<span class="text-muted">· {size(f.size)}</span>{/if}</a
						>
					{:else}
						<span class="mt-1 mr-2 inline-flex items-center gap-1 text-xs text-muted"
							><Paperclip class="size-3" />{f.name}</span
						>
					{/if}
				{/each}
			{/if}
			{#if onthread && m.replyCount > 0}
				<button
					class="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:underline"
					onclick={() => onthread(m.ts)}
					><MessageSquareReply class="size-3.5" />
					{m.replyCount}
					{m.replyCount === 1 ? 'reply' : 'replies'}</button
				>
			{:else if onthread && !m.deleted}
				<button
					class="mt-1 inline-flex items-center gap-1 text-xs text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-ink focus:opacity-100"
					onclick={() => onthread(m.ts)}
					><MessageSquareReply class="size-3.5" /> Reply in thread</button
				>
			{/if}
		</div>
	</div>
{/if}
