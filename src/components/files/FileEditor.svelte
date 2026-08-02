<script lang="ts">
  import { onMount } from 'svelte';
  import {
    EditorState,
    type Extension,
    Compartment,
    StateEffect,
    StateField
  } from '@codemirror/state';
  import {
    Decoration,
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    type DecorationSet
  } from '@codemirror/view';
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
    reveal?: SourceReveal | null;
    onReady?: (controller: FileEditorController) => void;
  }

  export interface SourceReveal {
    line: number;
    column?: number;
    focus?: boolean;
    scrollTop?: number | null;
    nonce?: number;
  }

  export interface FileEditorController {
    revealSource: (location: SourceReveal) => void;
    getScrollTop: () => number;
    focus: () => void;
  }

  let {
    value,
    relativePath,
    readOnly = false,
    onChange,
    onSave,
    reveal = null,
    onReady
  }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let view: EditorView | null = null;
  const langCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const sourceHighlightEffect = StateEffect.define<number | null>();
  const sourceHighlightField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, transaction) {
      let next = decorations.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (!effect.is(sourceHighlightEffect)) continue;
        if (effect.value === null) {
          next = Decoration.none;
          continue;
        }
        const line = transaction.state.doc.line(
          Math.min(Math.max(1, effect.value), transaction.state.doc.lines)
        );
        next = Decoration.set([Decoration.line({ attributes: { class: 'soloe-source-line' } }).range(line.from)]);
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field)
  });
  const sourceHighlightTheme = EditorView.baseTheme({
    '.cm-line.soloe-source-line': {
      backgroundColor: 'color-mix(in srgb, var(--solo-source-highlight, #22c55e) 14%, transparent)',
      boxShadow: 'inset 2px 0 0 var(--solo-source-highlight, #22c55e)'
    }
  });

  // Loaded language matches are cached per filename — language-data does the
  // dynamic import; we don't want to re-trigger it for each keystroke.
  const langCache = new Map<string, Extension>();

  // Svelte isn't in @codemirror/language-data. Fall back to HTML, whose
  // mixed mode already covers nested script and style blocks — close enough
  // to read Svelte 5 source without a dedicated Lezer grammar.
  const SVELTE_LANG = LanguageDescription.of({
    name: 'Svelte',
    alias: ['svelte'],
    extensions: ['svelte'],
    load: () => import('@codemirror/lang-html').then((m) => m.html({ matchClosingTags: true, autoCloseTags: true }))
  });
  const matchableLanguages = [SVELTE_LANG, ...languages];

  async function languageFor(path: string): Promise<Extension | null> {
    const cached = langCache.get(path);
    if (cached) return cached;
    const desc = LanguageDescription.matchFilename(matchableLanguages, path.split('/').pop() ?? path);
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
      sourceHighlightField,
      sourceHighlightTheme,
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
    onReady?.({ revealSource, getScrollTop, focus: () => view?.focus() });
    void hydrateLanguage(relativePath);
    return () => {
      view?.destroy();
      view = null;
    };
  });

  function revealSource(location: SourceReveal): void {
    if (!view) return;
    const line = Math.min(Math.max(1, Math.floor(location.line)), view.state.doc.lines);
    const lineInfo = view.state.doc.line(line);
    const column = Math.min(
      Math.max(1, Math.floor(location.column ?? 1)),
      Math.max(1, lineInfo.length + 1)
    );
    const position = lineInfo.from + column - 1;
    view.dispatch({
      selection: { anchor: position },
      effects: [
        sourceHighlightEffect.of(line),
        ...(location.scrollTop === undefined || location.scrollTop === null
          ? [EditorView.scrollIntoView(position, { y: 'center' })]
          : [])
      ]
    });
    if (location.scrollTop !== undefined && location.scrollTop !== null) {
      requestAnimationFrame(() => {
        if (view) view.scrollDOM.scrollTop = Math.max(0, location.scrollTop!);
      });
    }
    if (location.focus) view.focus();
  }

  function getScrollTop(): number {
    return view?.scrollDOM.scrollTop ?? 0;
  }

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

  $effect(() => {
    const request = reveal;
    if (!view || !request) return;
    const frame = requestAnimationFrame(() => revealSource(request));
    return () => cancelAnimationFrame(frame);
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
