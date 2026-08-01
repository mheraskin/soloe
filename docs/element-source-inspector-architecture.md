# Element Source Inspector architecture notes

## Existing integration points

The browser surface is implemented by `src/components/rail/RailBrowserTab.svelte`.
Each browser tab owns an Electron `<webview>` attachment and its lifecycle there. The
component already handles `dom-ready`, navigation, reload/failure, zoom, device emulation,
DevTools, and the host-side `ipc-message` event. The guest preload is
`electron/preload-webview.ts`; it forwards safe, structured events to the host with
`ipcRenderer.sendToHost`. The renderer-facing webview type is
`src/types/webview.d.ts`, and Electron configures the shared guest preload from
`electron/main.ts`.

Settings are typed in `shared/types/settings.ts`, parsed and persisted by
`electron/settings/SettingsStore.ts`, exposed through `electron/ipc/settings.ipc.ts`, and
consumed by `src/stores/settings.svelte.ts`. `src/components/forms/PreferencesForm.svelte`
is the existing settings UI. The browser settings category is the appropriate home for this
tool because the control belongs to the browser tab and the existing category already owns
browser developer controls.

The shortcut registry and global dispatch live in `src/lib/keymap.ts` and `src/App.svelte`.
The registry currently contains browser DevTools, browser zoom, pane, notes, files, terminal,
fullscreen, project, and session shortcuts. The inspector default will be `Ctrl+Alt+Shift+S`:
the complete current registry has no binding with that modifier/key signature, and it avoids
the common save, search, DevTools, browser navigation, editor, and operating-system
shortcuts. The setting will use the same key event dispatch path and a recorder in the
existing Shortcuts preferences UI.

Sticky notes are rendered by `src/components/StickyNotes.svelte`, with persistent note data
in `src/stores/notes.svelte.ts` and Electron persistence in `electron/notes/NotesStore.ts`.
The existing sticky window owns bounds clamping, drag/resize pointer interactions, focus,
stacking, close controls, and pin semantics. The inspector viewer will be rendered through
that sticky host and share its layout/interaction conventions; its transient and pinned
source entries will remain in a project/tab-scoped inspector store rather than in note
content persistence.

The files rail is `src/components/files/RailFilesTab.svelte`. It uses
`src/components/files/FileEditorSurface.svelte`, which embeds
`src/components/files/FileEditor.svelte`. The editor is CodeMirror 6, with language
extensions, line numbers, search, history, read-only compartments, and the existing
`soloCodeMirrorTheme`. File access goes through `src/stores/files.svelte.ts`,
`packages/domain/src/files/FileService.ts`, `electron/ipc/files.ipc.ts`, and
`shared/types/files.ts`. The service validates project-root containment and limits reads;
the inspector will use this path rather than exposing filesystem access to the guest.

Existing file navigation is `filesStore.openFileAt`, `rightRail.openTab('files')`, and the
`soloe:focus-pane` event used by `src/components/FilePalette.svelte`. A small reveal request
will extend this path so the main editor can reveal/highlight the same file and location
without creating a second file concept.

There is no existing language-server, definition provider, Svelte language service, or
CodeMirror LSP client in this repository. Component-stack navigation will therefore be
implemented from the locations returned by `element-source`; go-to-definition will not be
faked and remains a documented limitation unless an existing provider is discovered during
implementation.

## Editor capability verification

The official CodeMirror documentation and primary source were checked before implementation:

- [CodeMirror reference](https://codemirror.net/docs/ref/) documents `EditorView.scrollIntoView`,
  decorations, read-only extensions, and visible-viewport rendering.
- [CodeMirror split-view example](https://codemirror.net/examples/split/) notes that separate
  views do not automatically share synchronized editor state.
- [CodeMirror view source](https://github.com/codemirror/view/blob/main/src/editorview.ts)
  confirms the view's scroll effects and viewport-based rendering.

The implementation will use the existing complete-file loading and CodeMirror model creation,
which is appropriate for the repository's normal file-size limits. It will add a line
decoration and `EditorView.scrollIntoView` effect for source reveal. The sticky viewer will
reuse the existing file content/cache path, but will use its own read-only CodeMirror view;
the primary file editor remains the authoritative editable view.

`element-source` was checked against its official documentation and MIT-licensed repository:

- [element-source documentation](https://www.element-source.com/) documents
  `resolveElementInfo` and source/stack metadata.
- [element-source repository](https://github.com/aidenybai/element-source) documents the
  supported framework resolvers and MIT license.

The guest preload will call only `resolveElementInfo` and send structured metadata to the
host. It will not receive a filesystem bridge or project paths beyond the source metadata
already produced by the resolver.

## Planned state and lifecycle boundaries

Inspector mode, hover metadata, the delayed-open timer, transient viewer, pinned viewers,
request tokens, panel bounds, and per-viewer source history will be keyed by active project
scope and browser tab. `RailBrowserTab.svelte` is responsible for enabling/disabling the guest
listener and rejecting events from inactive or stale webview attachments. Navigation,
reload, tab close, webview destruction, project switching, and mode exit will clear transient
state and guest listeners. Pinned viewers retain their source content only while the existing
project/session lifecycle permits it; they are not given new restart persistence.

Source paths are normalized and checked against the associated project root before any file
operation. Reads go through the existing `FileService`/IPC authorization path. The guest
only sends the tab id, page URL, element identity, bounds, and source locations; it cannot
request arbitrary files.

The host overlay will map guest viewport coordinates through the webview's actual bounding
rectangle, so browser zoom, responsive scaling, resize, and nested page scrolling do not
change the panel placement calculation. The page-side overlay and callout will live in an
isolated shadow root, use `pointer-events: none`, and schedule pointer work through
`requestAnimationFrame` with debounced source resolution.
