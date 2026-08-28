import { mount, unmount } from 'svelte';
import AppSkeleton from './components/AppSkeleton.svelte';
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
import { usesMacosNativeWindowControls } from './lib/platform-ui';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app root element');
const rendererView = new URLSearchParams(window.location.search).get('view');

const bootstrapSkeleton = mount(AppSkeleton, {
  target,
  props: {
    label: rendererView === 'session-events' ? 'Loading Session events' : 'Starting Soloe',
    macosWindowControls: usesMacosNativeWindowControls()
  }
});

const { installBrowserApi } = await import('./lib/browser-api');
installBrowserApi();
if (
  'serviceWorker' in navigator
  && (window.location.protocol === 'http:' || window.location.protocol === 'https:')
) {
  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' });
    },
    { once: true }
  );
}
if (rendererView === 'session-events') {
  const { default: SessionEventsDebugView } = await import(
    './components/SessionEventsDebugView.svelte'
  );
  await unmount(bootstrapSkeleton);
  mount(SessionEventsDebugView, { target });
} else {
  const [
    { default: App },
    { initCommentsBridge },
    { initDiffBridge }
  ] = await Promise.all([
    import('./App.svelte'),
    import('./lib/comments-bridge'),
    import('./lib/diff-bridge-handler')
  ]);
  initCommentsBridge();
  initDiffBridge();
  await unmount(bootstrapSkeleton);
  mount(App, { target });
}
performance.mark('soloe:renderer-mounted');
