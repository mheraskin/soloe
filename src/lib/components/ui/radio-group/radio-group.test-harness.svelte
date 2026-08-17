<script lang="ts">
  import * as RadioGroup from '.';

  let value = $state('first');
</script>

<RadioGroup.Root bind:value>
  <RadioGroup.Item value="first" aria-label="First option" />
  <RadioGroup.Item value="second" aria-label="Second option" />
</RadioGroup.Root>
