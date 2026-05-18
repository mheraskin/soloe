import hljs from 'highlight.js/lib/common';
import { svelteLanguage } from './highlight-svelte';

// Register custom languages exactly once for the whole renderer process —
// hljs is a singleton in the `highlight.js/lib/common` module, so calling
// `registerLanguage` from a side-effect import keeps both the diff viewer
// and the markdown renderer in sync.
if (!hljs.getLanguage('svelte')) {
  hljs.registerLanguage('svelte', svelteLanguage);
}

export { hljs };
