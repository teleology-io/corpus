<script lang="ts">
	import NoteEditor from '#lib/components/notes/NoteEditor.svelte';
	import Logo from '#lib/components/ui/Logo.svelte';
	import { colorFor } from '#lib/components/notes/presence.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const editable = $derived(data.role === 'edit');
</script>

<svelte:head><title>{data.note.title || 'Untitled'} · Corpus</title></svelte:head>

<div class="min-h-dvh bg-surface">
	<header class="flex items-center gap-3 border-b border-line px-6 py-3">
		<a href="/"><Logo size={24} /></a>
		<span class="ml-2 chip bg-canvas text-muted"
			>{editable ? 'Anyone with the link can edit' : 'View only'}</span
		>
		<a href="/sign-up" class="ml-auto btn-primary h-8 text-xs">Try Corpus</a>
	</header>
	<article class="mx-auto max-w-3xl px-6 pt-12 pb-32">
		<div class="pl-6">
			<div class="mb-2 text-5xl">{data.note.icon ?? '📄'}</div>
			<h1 class="text-4xl font-bold tracking-tight">{data.note.title || 'Untitled'}</h1>
		</div>
		<div class="mt-6">
			<NoteEditor
				noteId={data.note.id}
				collabUrl={data.collabUrl}
				token={async () => data.token}
				user={{ name: data.viewer.name, color: colorFor(data.viewer.id) }}
				{editable}
			/>
		</div>
	</article>
</div>
