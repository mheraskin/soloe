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

export function highlightLine(text: string, language: string | null): string {
  if (!text) return '';
  if (!language) return escapeHtml(text);
  const key = `${language}\0${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    // Runes (`$state`, `$derived`, …) appear inside script blocks delegated
    // to the JS sub-language, which doesn't know about them. Wrap them here.
    if (language === 'svelte' || language === 'javascript' || language === 'typescript') {
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
