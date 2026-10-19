<script lang="ts">
	import { Switch } from 'bits-ui';

	let {
		checked = $bindable(false),
		label,
		disabled = false,
		onchange
	}: {
		checked?: boolean;
		label?: string;
		disabled?: boolean;
		onchange?: (v: boolean) => void;
	} = $props();
</script>

<Switch.Root
	bind:checked
	{disabled}
	aria-label={label}
	onCheckedChange={(v) => onchange?.(v)}
	class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-gray-200 transition-colors disabled:opacity-50 data-[state=checked]:bg-primary-500"
>
	<Switch.Thumb
		class="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-[18px]"
	/>
</Switch.Root>
