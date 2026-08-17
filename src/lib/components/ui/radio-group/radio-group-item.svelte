<script lang="ts">
	import { RadioGroup as RadioGroupPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<RadioGroupPrimitive.ItemProps> = $props();
</script>

<RadioGroupPrimitive.Item
	bind:ref
	data-slot="radio-group-item"
	class={cn(
		"data-[state=unchecked]:border-muted-foreground/60 data-[state=unchecked]:bg-background dark:data-[state=unchecked]:border-muted-foreground/75 dark:data-[state=unchecked]:bg-input/35 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground aria-invalid:border-destructive focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 dark:aria-invalid:border-destructive/60 flex size-[18px] rounded-full shadow-xs transition-[background-color,border-color,color,box-shadow] focus-visible:ring-3 aria-invalid:ring-3 group/radio-group-item peer relative aspect-square shrink-0 border outline-none after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<div data-slot="radio-group-indicator" class="flex size-full items-center justify-center">
			{#if checked}
				<span class="size-2 rounded-full bg-primary-foreground shadow-sm"></span>
			{/if}
		</div>
	{/snippet}
</RadioGroupPrimitive.Item>
