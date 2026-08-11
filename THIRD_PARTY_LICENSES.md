# Third-Party Notices

Soloe bundles software from third parties. The terms below apply to each
bundled component and are reproduced here to satisfy attribution requirements.
Full license text for each package is also available in
`node_modules/<package>/LICENSE` (or `LICENSE.md`) in shipped builds.

---

## @pierre/trees

Path-first file tree UI, used by the Files rail tab.

- Project: https://github.com/pierrecomputer/pierre/tree/main/packages/trees
- License: Apache License 2.0
- Copyright: 2025 Pierre Computer Company

### NOTICE (from @pierre/trees)

This project includes some code derived from
[@headless-tree/core](https://github.com/lukasbach/headless-tree).

The initial version of this project used `headless-tree` as the underlying tree
implementation. Pierre have since written their own core at `packages/path-store`,
but many of the best ideas from `headless-tree` made their way to `path-store`
and `trees`.

Original license for `headless-tree/core` (MIT, Copyright (c) 2023 Lukas Bach)
is reproduced in `node_modules/@pierre/trees/NOTICE.md`.

The full Apache 2.0 license text shipped with the package lives at
`node_modules/@pierre/trees/LICENSE.md`.

---

## CodeMirror 6

In-editor code view used by the Files rail tab.

- Project: https://codemirror.net/
- License: MIT
- Copyright: 2018-present by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Packages bundled:

- `codemirror`
- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/language`
- `@codemirror/language-data` (and the language packages it lazy-loads)
- `@codemirror/commands`
- `@codemirror/search`

Full MIT license text ships with each package at
`node_modules/<package>/LICENSE`.

---

## element-source

Development-only DOM-to-source metadata resolver used by the Element Source
Inspector. No other complete inspector product is bundled.

- Project: https://github.com/aidenybai/element-source
- License: MIT
- Copyright: the element-source contributors

The full MIT license text ships with `node_modules/element-source/LICENSE`.

---

## Ghostty

The experimental native Terminal Presentation uses official `libghostty-vt`
on Linux and a checksum-pinned `manaflow-ai/ghostty` manual-I/O surface fork on
macOS. cmux is an architectural reference only; no cmux application code is
bundled.

- Project: https://github.com/ghostty-org/ghostty
- Surface fork: https://github.com/manaflow-ai/ghostty
- License: MIT
- Copyright: 2024 Mitchell Hashimoto, Ghostty contributors

The full MIT license is reproduced in
`apps/desktop-tauri/src-tauri/libghostty-LICENSE`.

---

The Apache 2.0 terms for `@pierre/trees` require preserving its NOTICE text
when that component is redistributed. Soloe's own source is MIT-licensed;
every dependency retains its own terms. This file enumerates components that
require notice preservation or whose terms differ meaningfully from Soloe's.
