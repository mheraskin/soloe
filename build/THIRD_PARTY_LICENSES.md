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

## T3 Code Ghostty web terminal

Soloe adapts the browser-facing Ghostty terminal core, Canvas2D renderer,
DOM/input surface, key encoder integration, link parser, tests, WebAssembly
loader, and terminal-history sanitizer from T3 Code.

- Project: https://github.com/pingdotgg/t3code
- Source revision: `82b8a9380298509d68170961d9717be62836e490`
- License: MIT
- Copyright: 2026 T3 Tools Inc.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Ghostty libghostty-vt WebAssembly

The terminal parser, grid, reflow, selection, and keyboard/mouse encoders are
compiled from Ghostty into `ghostty-vt.wasm` by T3 Code.

- Project: https://github.com/ghostty-org/ghostty
- Source revision: `9f62873bf195e4d8a762d768a1405a5f2f7b1697`
- License: MIT
- Copyright: 2024 Mitchell Hashimoto, Ghostty contributors

MIT License

Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Symbols Nerd Font Mono

Soloe bundles the symbols-only webfont used by the Ghostty browser surface.

- Project: https://github.com/ryanoasis/nerd-fonts
- License: MIT
- Copyright: 2014 Ryan L McIntyre

The MIT License (MIT)

Copyright (c) 2014 Ryan L McIntyre

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

The Apache 2.0 terms for `@pierre/trees` require preserving its NOTICE text
when that component is redistributed. Soloe's own source is MIT-licensed;
every dependency retains its own terms. This file enumerates components that
require notice preservation or whose terms differ meaningfully from Soloe's.
