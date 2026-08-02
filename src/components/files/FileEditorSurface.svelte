<script lang="ts">
  import FileEditor from './FileEditor.svelte';
  import EditorContextMenu from './EditorContextMenu.svelte';
  import EditorSelectionMenu from './EditorSelectionMenu.svelte';

  interface Props {
    value: string;
    relativePath: string;
    rootEl: HTMLElement | null;
    onChange?: (next: string) => void;
    onSave?: () => void;
  }

  let { value, relativePath, rootEl, onChange, onSave }: Props = $props();
</script>

<EditorContextMenu {relativePath} {rootEl}>
  {#snippet children()}
    <FileEditor {value} {relativePath} {onChange} {onSave} />
  {/snippet}
</EditorContextMenu>
<EditorSelectionMenu {relativePath} {rootEl} />
