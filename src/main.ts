import { mount } from 'svelte';
import '@fontsource-variable/inter/index.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
// JetBrains Mono's @fontsource subsets don't cover U+2500-259F (box drawing)
// or other terminal glyphs, so the browser falls back to system monospace —
// whose box-drawing chars don't fill the cell, which is why TUI rules render
// as dashed lines. Cascadia Code's symbol subset does cover those ranges,
// so it's loaded as a secondary monospace family for the terminal stack.
import '@fontsource/cascadia-code/400.css';
import '@fontsource/cascadia-code/700.css';
import App from './App.svelte';
import { initCommentsBridge } from './lib/comments-bridge';
import { initDiffBridge } from './lib/diff-bridge-handler';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app root element');

initCommentsBridge();
initDiffBridge();
mount(App, { target });
performance.mark('soloe:renderer-mounted');
