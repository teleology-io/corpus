<script lang="ts">
	import { page } from '$app/state';
</script>

<section
	class="rounded-xl border border-line bg-surface px-6 py-16 text-center shadow-card"
	role="alert"
>
	<p class="text-lg font-semibold">
		{page.status === 404 ? 'Not found' : 'Couldn’t load this view'}
	</p>
	<p class="mt-1 text-sm text-muted">
		{page.status === 404
			? 'That page or record doesn’t exist.'
			: 'The last request failed. Nothing was changed.'}
	</p>
	{#if page.error?.message && page.status !== 404}
		<p class="mt-3 font-mono text-xs text-muted">{page.error.message}</p>
	{/if}
	<a href={page.url.pathname} class="mt-6 btn">Try again</a>
</section>
