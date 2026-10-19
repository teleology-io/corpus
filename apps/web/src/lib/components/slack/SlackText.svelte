<script lang="ts">
	import type { SlackSegment } from '#lib/types.js';

	let { segments }: { segments: SlackSegment[] } = $props();
</script>

<!-- Segments come from a tokenizer, never raw HTML, so Slack content can't inject markup. -->
<div class="text-sm leading-relaxed break-words">
	{#each segments as s, i (i)}
		{#if s.t === 'link'}<a
				href={s.href}
				target="_blank"
				rel="noreferrer"
				class="text-primary-600 underline-offset-2 hover:underline">{s.v}</a
			>{:else if s.t === 'user' || s.t === 'channel'}<span
				class="rounded bg-primary-50 px-0.5 font-medium text-primary-700">{s.v}</span
			>{:else if s.t === 'bold'}<strong>{s.v}</strong>{:else if s.t === 'italic'}<em>{s.v}</em
			>{:else if s.t === 'strike'}<s>{s.v}</s>{:else if s.t === 'code'}<code
				class="rounded bg-canvas px-1 py-0.5 font-mono text-[12px]">{s.v}</code
			>{:else if s.t === 'pre'}<pre
				class="my-1 overflow-x-auto rounded-lg bg-canvas p-2 font-mono text-[12px]">{s.v}</pre>{:else}<span
				class="whitespace-pre-wrap">{s.v}</span
			>{/if}
	{/each}
</div>
