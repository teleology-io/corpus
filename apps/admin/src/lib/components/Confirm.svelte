<script lang="ts">
	import { enhance } from '$app/forms';
	import type { Snippet } from 'svelte';
	import { toast } from '#lib/toast.svelte.js';

	/**
	 * A button that opens a confirmation dialog posting to a form action. The reason field is
	 * required and lands in the audit log. On failure the dialog stays open with the error and
	 * the typed reason intact.
	 */
	let {
		action,
		title,
		impact,
		confirmLabel = 'Confirm',
		success,
		fields = {},
		danger = true,
		children
	}: {
		action: string;
		title: string;
		impact: string;
		confirmLabel?: string;
		/** Toast shown once the change is saved. */
		success: string;
		fields?: Record<string, string>;
		danger?: boolean;
		children: Snippet;
	} = $props();

	const uid = $props.id();
	let dialog: HTMLDialogElement | undefined = $state();
	let form: HTMLFormElement | undefined = $state();
	let error = $state('');
	let busy = $state(false);

	function open() {
		error = '';
		form?.reset();
		dialog?.showModal();
	}
</script>

<button type="button" class={danger ? 'btn-danger-outline btn' : 'btn'} onclick={open}>
	{@render children()}
</button>

<dialog
	bind:this={dialog}
	aria-labelledby="{uid}-title"
	aria-describedby="{uid}-impact"
	class="m-auto w-[460px] max-w-[calc(100%-2rem)] rounded-xl border border-line bg-surface p-6 text-ink shadow-pop backdrop:bg-gray-900/40"
>
	<form
		bind:this={form}
		method="POST"
		{action}
		use:enhance={() => {
			busy = true;
			error = '';
			return async ({ result, update }) => {
				busy = false;
				if (result.type === 'failure') {
					error = String(result.data?.error ?? 'The change was not saved.');
					return;
				}
				if (result.type === 'error') {
					error = result.error?.message ?? 'The change was not saved.';
					return;
				}
				dialog?.close();
				toast(success);
				await update({ reset: true, invalidateAll: true });
			};
		}}
	>
		{#each Object.entries(fields) as [name, value] (name)}
			<input type="hidden" {name} {value} />
		{/each}
		<h2 id="{uid}-title" class="text-lg font-semibold">{title}</h2>
		<p id="{uid}-impact" class="mt-2 text-sm leading-relaxed text-muted">{impact}</p>
		<label class="mt-5 block text-sm font-medium" for="{uid}-reason">
			Reason <span class="font-normal text-muted">(required · recorded in the audit log)</span>
		</label>
		<input
			id="{uid}-reason"
			name="reason"
			required
			minlength="3"
			maxlength="500"
			autocomplete="off"
			placeholder="Why is this change needed?"
			class="mt-2 input w-full"
			aria-invalid={error ? 'true' : undefined}
			aria-errormessage={error ? `${uid}-error` : undefined}
		/>
		{#if error}<p id="{uid}-error" class="mt-2 text-sm text-red-600" role="alert">{error}</p>{/if}
		<footer class="mt-6 flex justify-end gap-2">
			<!-- Cancel is the safe default when a destructive dialog opens. -->
			<!-- svelte-ignore a11y_autofocus -->
			<button type="button" class="btn" autofocus onclick={() => dialog?.close()}>Cancel</button>
			<button type="submit" class={danger ? 'btn-danger btn' : 'btn-primary btn'} disabled={busy}>
				{busy ? 'Saving…' : confirmLabel}
			</button>
		</footer>
	</form>
</dialog>
