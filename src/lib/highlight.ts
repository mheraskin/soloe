import { hljs } from './hljs';
import { applyRuneHighlights } from './highlight-svelte';

const EXTENSION_TO_LANG: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svelte: 'svelte',
  vue: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  sql: 'sql',
  php: 'php',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  diff: 'diff',
  patch: 'diff'
};

const FILENAME_TO_LANG: Record<string, string> = {
  Makefile: 'makefile',
  makefile: 'makefile',
  GNUmakefile: 'makefile'
};

export function languageForPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split(/[\\/]/).pop() ?? path;
  if (FILENAME_TO_LANG[base]) return FILENAME_TO_LANG[base];
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  const lang = EXTENSION_TO_LANG[ext];
  if (!lang) return null;
  return hljs.getLanguage(lang) ? lang : null;
}

const cache = new Map<string, string>();
const MAX_CACHE = 5000;

// The svelte grammar only delegates `<script>` content to JS/TS when the
// script's opening tag is in scope. The diff viewer feeds lines one at a time,
// so a body line like `let n = $state(0)` reaches the highlighter without that
// scope and falls through unhighlighted. Pick a per-line grammar: lines that
// look like markup (a tag or `{#:/@…}` block) keep svelte, everything else
// goes to TS so script-body keywords and identifiers get coloured. Runes are
// re-wrapped by `applyRuneHighlights` regardless of which branch ran.
function effectiveLanguage(text: string, language: string): string {
  if (language !== 'svelte') return language;
  const trimmed = text.trimStart();
  if (!trimmed) return language;
  if (trimmed.charCodeAt(0) === 60 /* < */) return 'svelte';
  if (trimmed.charCodeAt(0) === 123 /* { */ && /^\{[#:/@]/.test(trimmed)) return 'svelte';
  return 'typescript';
}

export function highlightLine(text: string, language: string | null): string {
  if (!text) return '';
  if (!language) return escapeHtml(text);
  const key = `${language}\0${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const lang = effectiveLanguage(text, language);
  let html: string;
  try {
    html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    if (lang === 'svelte' || lang === 'javascript' || lang === 'typescript') {
      html = applyRuneHighlights(html);
    }
  } catch {
    html = escapeHtml(text);
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, html);
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
  );
}
