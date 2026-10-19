<script lang="ts" module>
	import {
		Calendar,
		Users,
		Presentation,
		GraduationCap,
		Camera,
		MessageSquare,
		Stethoscope,
		Heart,
		Briefcase,
		Pill,
		Plane,
		Dumbbell,
		Code,
		Phone,
		Video,
		BookOpen
	} from '@lucide/svelte';

	export const ICONS = {
		calendar: Calendar,
		users: Users,
		presentation: Presentation,
		'graduation-cap': GraduationCap,
		camera: Camera,
		'message-square': MessageSquare,
		stethoscope: Stethoscope,
		heart: Heart,
		briefcase: Briefcase,
		pill: Pill,
		plane: Plane,
		dumbbell: Dumbbell,
		code: Code,
		phone: Phone,
		video: Video,
		book: BookOpen
	} as const;
	export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
	let { name, class: cls = 'size-4' }: { name: string; class?: string } = $props();
	const Cmp = $derived(ICONS[name as IconName] ?? Calendar);
</script>

<Cmp class={cls} />
