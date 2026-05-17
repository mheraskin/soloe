import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

// Mirrors the diff viewer's hljs token colors (see :root / .dark in app.css)
// so the file editor and the diff body share a single palette. The chrome
// styles read app CSS vars directly so light/dark mode flips just work.
const editorTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--foreground)',
      backgroundColor: 'var(--background)',
      fontFamily: 'var(--font-mono)',
      fontSize: '12.5px',
      height: '100%'
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.55'
    },
    '.cm-content': {
      caretColor: 'var(--foreground)'
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--foreground)'
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 28%, transparent)'
    },
    '.cm-gutters': {
      backgroundColor: 'color-mix(in oklch, var(--muted) 35%, transparent)',
      color: 'var(--muted-foreground)',
      border: 'none',
      borderRight: '1px solid color-mix(in oklch, var(--border) 60%, transparent)'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in oklch, var(--muted) 60%, transparent)',
      color: 'var(--foreground)'
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in oklch, var(--muted) 25%, transparent)'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 6px'
    },
    '.cm-foldGutter .cm-gutterElement': {
      color: 'var(--muted-foreground)'
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--popover)',
      color: 'var(--popover-foreground)',
      border: '1px solid var(--border)'
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--muted)',
      color: 'var(--foreground)'
    },
    '.cm-panels': {
      backgroundColor: 'var(--card)',
      color: 'var(--card-foreground)',
      borderColor: 'var(--border)'
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in oklch, var(--ring) 32%, transparent)'
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in oklch, var(--ring) 55%, transparent)'
    }
  },
  { dark: false }
);

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: 'var(--hl-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--hl-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--hl-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--hl-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--hl-type)' },
  { tag: [t.variableName, t.propertyName], color: 'var(--hl-variable)' },
  { tag: [t.tagName, t.heading, t.contentSeparator], color: 'var(--hl-tag)' },
  { tag: [t.attributeName, t.attributeValue], color: 'var(--hl-attr)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--hl-meta)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.link, color: 'var(--primary)', textDecoration: 'underline' }
]);

export function soloeCodeMirrorTheme(): Extension {
  return [editorTheme, syntaxHighlighting(highlightStyle)];
}
