<script lang="ts">
  import FileEditor, {
    type FileEditorController,
    type SourceReveal
  } from './FileEditor.svelte';
  import EditorContextMenu from './EditorContextMenu.svelte';
  import EditorSelectionMenu from './EditorSelectionMenu.svelte';

  interface Props {
    value: string;
    relativePath: string;
    rootEl: HTMLElement | null;
    onChange?: (next: string) => void;
    onSave?: () => void;
    readOnly?: boolean;
    reveal?: SourceReveal | null;
    onReady?: (controller: FileEditorController) => void;
  }

  let {
    value,
    relativePath,
    rootEl,
    onChange,
    onSave,
    readOnly = false,
    reveal = null,
    onReady
  }: Props = $props();
</script>

<EditorContextMenu {relativePath} {rootEl}>
  {#snippet children()}
    <FileEditor
      {value}
      {relativePath}
      {onChange}
      {onSave}
      {readOnly}
      {reveal}
      {onReady}
    />
  {/snippet}
</EditorContextMenu>
<EditorSelectionMenu {relativePath} {rootEl} />
