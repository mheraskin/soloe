<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorState, type Extension, Compartment } from '@codemirror/state';
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
  import { LanguageDescription } from '@codemirror/language';
  import { languages } from '@codemirror/language-data';
  import { soloeCodeMirrorTheme } from '../../lib/codemirror-theme';

  interface Props {
    value: string;
    relativePath: string;
    readOnly?: boolean;
    onChange?: (next: string) => void;
    onSave?: () => void;
  }

  let { value, relativePath, readOnly = false, onChange, onSave }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let view: EditorView | null = null;
  const langCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  // Loaded language matches are cached per filename — language-data does the
  // dynamic import; we don't want to re-trigger it for each keystroke.
  const langCache = new Map<string, Extension>();

  async function languageFor(path: string): Promise<Extension | null> {
    const cached = langCache.get(path);
    if (cached) return cached;
    const desc = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? path);
    if (!desc) return null;
    try {
      const support = await desc.load();
      langCache.set(path, support);
      return support;
    } catch {
      return null;
    }
  }

  function buildExtensions(): Extension[] {
    const saveKey = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          onSave?.();
          return true;
        }
      }
    ]);
    return [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      saveKey,
      EditorView.lineWrapping,
      soloeCodeMirrorTheme(),
      readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
      langCompartment.of([]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const next = u.state.doc.toString();
        onChange?.(next);
      })
    ];
  }

  onMount(() => {
    if (!host) return;
    view = new EditorView({
      state: EditorState.create({ doc: value, extensions: buildExtensions() }),
      parent: host
    });
    void hydrateLanguage(relativePath);
    return () => {
      view?.destroy();
      view = null;
    };
  });

  async function hydrateLanguage(path: string): Promise<void> {
    const ext = (await languageFor(path)) ?? [];
    if (!view) return;
    view.dispatch({ effects: langCompartment.reconfigure(ext) });
  }

  // Reflect external value changes (file reload, save, switch file) without
  // wiping the user's cursor when the doc didn't actually move. Compare before
  // dispatching so onChange echoes don't bounce a no-op update back through.
  $effect(() => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value }
    });
  });

  $effect(() => {
    void relativePath;
    void hydrateLanguage(relativePath);
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
  });
</script>

<div bind:this={host} class="soloe-cm-host flex min-h-0 flex-1"></div>

<style>
  .soloe-cm-host :global(.cm-editor) {
    width: 100%;
    height: 100%;
  }
  .soloe-cm-host :global(.cm-editor.cm-focused) {
    outline: none;
  }
</style>
