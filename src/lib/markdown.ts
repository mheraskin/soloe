import { Marked, type RendererObject, type Tokens } from 'marked';
import { hljs } from './hljs';
import { applyRuneHighlights } from './highlight-svelte';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;'
  );
}

function highlightCode(text: string, lang: string | undefined): string {
  if (!lang) return escapeHtml(text);
  const normalized = lang.toLowerCase().split(/\s+/)[0];
  if (!normalized) return escapeHtml(text);
  const resolved = hljs.getLanguage(normalized) ? normalized : null;
  if (!resolved) return escapeHtml(text);
  try {
    let html = hljs.highlight(text, { language: resolved, ignoreIllegals: true }).value;
    if (resolved === 'svelte' || resolved === 'javascript' || resolved === 'typescript') {
      html = applyRuneHighlights(html);
    }
    return html;
  } catch {
    return escapeHtml(text);
  }
}

const renderer: RendererObject = {
  // Drop inline raw HTML — the LLM output is markdown; if a stray `<tag>`
  // sneaks in we render it as text rather than executing it.
  html({ text }: Tokens.HTML | Tokens.Tag) {
    return escapeHtml(text);
  },
  code({ text, lang }: Tokens.Code) {
    const highlighted = highlightCode(text, lang);
    const cls = lang ? `hljs language-${escapeHtml(lang)}` : 'hljs';
    return `<pre class="md-code"><code class="${cls}">${highlighted}</code></pre>`;
  }
};

const md = new Marked({ gfm: true, breaks: true, renderer });

export function renderMarkdown(text: string): string {
  if (!text) return '';
  const out = md.parse(text);
  return typeof out === 'string' ? out : '';
}
