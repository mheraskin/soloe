<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";

	let { open = $bindable(false), ...restProps }: DialogPrimitive.RootProps = $props();

	let wasOpen = false;
	$effect(() => {
		if (wasOpen && !open) {
			window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
		}
		wasOpen = open;
	});
</script>

<DialogPrimitive.Root bind:open {...restProps} />
