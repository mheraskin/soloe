import type { HLJSApi, Language, Mode } from 'highlight.js';

// Svelte 5 language for highlight.js — covers the template surface (tags,
// directives, block expressions) and delegates `<script>` / `<style>` content
// to the javascript and css sub-languages. Runes inside script blocks get
// re-highlighted by the caller; doing it via subLanguage means we'd have to
// fork JS keyword tables, which is brittle across hljs versions.

const RUNE_NAMES = [
  '$state',
  '$state.raw',
  '$state.snapshot',
  '$derived',
  '$derived.by',
  '$effect',
  '$effect.pre',
  '$effect.root',
  '$effect.tracking',
  '$props',
  '$bindable',
  '$inspect',
  '$host'
] as const;

const RUNE_RE = /\$(?:state|derived|effect|props|bindable|inspect|host)(?:\.(?:raw|snapshot|by|pre|root|tracking))?\b/g;

// Wrap unhighlighted rune identifiers in the output of hljs so they pick up
// the `hljs-built_in` class. Safe to run over the full output because the
// pattern is anchored on `$` which can't appear inside an hljs class name
// or attribute value emitted by the highlighter.
export function applyRuneHighlights(html: string): string {
  return html.replace(RUNE_RE, (m) => `<span class="hljs-built_in">${m}</span>`);
}

const BLOCK_KEYWORDS = ['if', 'each', 'await', 'key', 'snippet', 'else', 'then', 'catch'];
const SPECIAL_KEYWORDS = ['render', 'const', 'html', 'debug'];

export function svelteLanguage(hljs: HLJSApi): Language {
  // {#if expr}, {:else if expr}, {/each}, {@render foo(bar)}, {@const x = 1}
  const TEMPLATE_BLOCK: Mode = {
    className: 'template-tag',
    begin: /\{(?:[#:/]|@)/,
    end: /\}/,
    returnBegin: false,
    contains: [
      {
        className: 'name',
        begin: new RegExp(`(?:${[...BLOCK_KEYWORDS, ...SPECIAL_KEYWORDS].join('|')})\\b`)
      },
      {
        // Expression payload inside the block tag — defer to JS.
        begin: /\s/,
        end: /(?=\})/,
        excludeBegin: true,
        excludeEnd: true,
        subLanguage: 'javascript',
        relevance: 0
      }
    ]
  };

  // Plain `{expression}` interpolation in markup.
  const TEMPLATE_EXPRESSION: Mode = {
    className: 'template-variable',
    begin: /\{(?![#:/@])/,
    end: /\}/,
    excludeBegin: true,
    excludeEnd: true,
    subLanguage: 'javascript',
    relevance: 0
  };

  // <script ...> ... </script>
  const SCRIPT_TAG: Mode = {
    className: 'tag',
    begin: /<script(?=\s|>)/,
    end: />/,
    keywords: { name: 'script' },
    contains: [
      {
        className: 'attr',
        begin: /[A-Za-z_][A-Za-z0-9_:-]*/,
        relevance: 0
      },
      hljs.QUOTE_STRING_MODE,
      hljs.APOS_STRING_MODE
    ],
    starts: {
      end: /<\/script>/,
      returnEnd: true,
      subLanguage: ['typescript', 'javascript']
    }
  };

  // <style ...> ... </style>
  const STYLE_TAG: Mode = {
    className: 'tag',
    begin: /<style(?=\s|>)/,
    end: />/,
    keywords: { name: 'style' },
    contains: [
      {
        className: 'attr',
        begin: /[A-Za-z_][A-Za-z0-9_:-]*/,
        relevance: 0
      },
      hljs.QUOTE_STRING_MODE,
      hljs.APOS_STRING_MODE
    ],
    starts: {
      end: /<\/style>/,
      returnEnd: true,
      subLanguage: ['css']
    }
  };

  // Attribute value as {expression}: `class={x}`, `value={form.email}`.
  const ATTR_EXPR_VALUE: Mode = {
    begin: /=\{/,
    end: /\}/,
    excludeBegin: true,
    excludeEnd: true,
    subLanguage: 'javascript',
    relevance: 0
  };

  // Shorthand attribute: `{value}` as the whole attribute slot.
  const ATTR_SHORTHAND: Mode = {
    className: 'template-variable',
    begin: /\{/,
    end: /\}/,
    excludeBegin: true,
    excludeEnd: true,
    subLanguage: 'javascript',
    relevance: 0
  };

  // Directives — `bind:value`, `on:click|preventDefault`, `use:fly`, etc.
  // Class added so theming can target them, but `attr` lets them inherit the
  // existing attribute color without a separate CSS rule.
  const DIRECTIVE: Mode = {
    className: 'attr',
    begin: /(?:bind|on|use|transition|in|out|animate|class|style|let):[A-Za-z_][A-Za-z0-9_-]*(?:\|[A-Za-z_][A-Za-z0-9_-]*)*/
  };

  const TAG_INTERNALS: Mode = {
    endsWithParent: true,
    illegal: /</,
    relevance: 0,
    contains: [
      DIRECTIVE,
      {
        className: 'attr',
        begin: /[A-Za-z_][A-Za-z0-9_:-]*/
      },
      {
        begin: /=/,
        relevance: 0,
        contains: [
          hljs.QUOTE_STRING_MODE,
          hljs.APOS_STRING_MODE,
          ATTR_EXPR_VALUE
        ]
      },
      ATTR_SHORTHAND
    ]
  };

  const TAG_NAME = /[A-Za-z_][A-Za-z0-9_:.-]*/;

  const OPEN_TAG: Mode = {
    className: 'tag',
    begin: hljs.regex.concat(/</, hljs.regex.lookahead(hljs.regex.concat(TAG_NAME, hljs.regex.either(/\/>/, />/, /\s/)))),
    end: /\/?>/,
    contains: [
      {
        className: 'name',
        begin: TAG_NAME,
        relevance: 0,
        starts: TAG_INTERNALS
      }
    ]
  };

  const CLOSE_TAG: Mode = {
    className: 'tag',
    begin: hljs.regex.concat(/<\//, hljs.regex.lookahead(hljs.regex.concat(TAG_NAME, />/))),
    end: />/,
    contains: [
      {
        className: 'name',
        begin: TAG_NAME,
        relevance: 0
      }
    ]
  };

  return {
    name: 'Svelte',
    aliases: ['svelte'],
    case_insensitive: false,
    contains: [
      hljs.COMMENT('<!--', '-->'),
      SCRIPT_TAG,
      STYLE_TAG,
      TEMPLATE_BLOCK,
      TEMPLATE_EXPRESSION,
      OPEN_TAG,
      CLOSE_TAG
    ]
  };
}

export const SVELTE_RUNES: readonly string[] = RUNE_NAMES;
