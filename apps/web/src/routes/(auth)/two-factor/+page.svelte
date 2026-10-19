<script lang="ts">
	import { goto } from '$app/navigation';
	import { authClient } from '@corpus/auth/client';

	let code = $state('');
	let useBackup = $state(false);
	let trust = $state(true);
	let error = $state('');
	let busy = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		const res = useBackup
			? await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice: trust })
			: await authClient.twoFactor.verifyTotp({ code: code.trim(), trustDevice: trust });
		busy = false;
		if (res.error) error = res.error.message ?? 'Invalid code';
		else await goto('/dashboard');
	}
</script>

<svelte:head><title>Two-factor · Corpus</title></svelte:head>

<h1 class="text-2xl font-bold tracking-tight">Two-factor authentication</h1>
<p class="mt-1 text-muted">
	{useBackup
		? 'Enter one of your backup codes.'
		: 'Enter the 6-digit code from your authenticator app.'}
</p>

<form class="mt-8 space-y-4" onsubmit={submit}>
	<input
		class="input h-12 text-center text-lg tracking-[0.4em]"
		inputmode={useBackup ? 'text' : 'numeric'}
		autocomplete="one-time-code"
		required
		bind:value={code}
	/>
	<label class="flex items-center gap-2 text-sm text-muted">
		<input type="checkbox" bind:checked={trust} class="rounded" /> Trust this device for 30 days
	</label>
	{#if error}<p class="text-sm text-red-600">{error}</p>{/if}
	<button class="btn-primary h-10 w-full" disabled={busy}>Verify</button>
</form>
<button
	class="mt-4 w-full text-center text-sm text-primary-600 hover:underline"
	onclick={() => (useBackup = !useBackup)}
>
	{useBackup ? 'Use authenticator code' : 'Use a backup code'}
</button>
