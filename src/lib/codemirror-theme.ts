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
    // CodeMirror paints a focus outline by default; we already use a subtle
    // active-line tint and the cursor caret as focus indicators, so kill the
    // outline to match the rail's flush chrome.
    '&.cm-focused': {
      outline: 'none'
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.55'
    },
    '.cm-content': {
      caretColor: 'var(--foreground)',
      padding: '4px 0'
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--foreground)'
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 28%, transparent)'
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in oklch, var(--ring) 18%, transparent)'
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
      border: '1px solid var(--border)',
      borderRadius: '6px',
      boxShadow: '0 8px 24px -8px color-mix(in oklch, var(--foreground) 25%, transparent)'
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      padding: '2px 8px',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px'
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--muted)',
      color: 'var(--foreground)'
    },
    // Search/replace panel chrome. CodeMirror renders it inside `.cm-panel`
    // at the editor's bottom with raw <input class="cm-textfield"> and
    // <button class="cm-button"> children — restyle each to match the app's
    // input/button language so the panel doesn't break the visual hierarchy.
    '.cm-panels': {
      backgroundColor: 'var(--card)',
      color: 'var(--card-foreground)',
      borderColor: 'var(--border)'
    },
    '.cm-panels.cm-panels-bottom': {
      borderTop: '1px solid var(--border)'
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid var(--border)'
    },
    '.cm-panel': {
      padding: '6px 8px',
      fontFamily: 'var(--font-sans)',
      fontSize: '11px'
    },
    '.cm-panel.cm-search': {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '4px'
    },
    '.cm-panel.cm-search label': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      color: 'var(--muted-foreground)',
      fontSize: '11px'
    },
    '.cm-panel.cm-search label input[type=checkbox]': {
      accentColor: 'var(--primary)'
    },
    '.cm-panel.cm-search br': {
      // The default panel uses a <br> between rows; collapse it so the
      // checkboxes wrap inline with the buttons instead of forcing a new row
      // that doubles the panel height.
      display: 'none'
    },
    '.cm-textfield': {
      height: '24px',
      minWidth: '160px',
      padding: '0 8px',
      borderRadius: '4px',
      border: '1px solid var(--input)',
      backgroundColor: 'var(--background)',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      outline: 'none'
    },
    '.cm-textfield:focus': {
      borderColor: 'var(--ring)',
      boxShadow: '0 0 0 1px var(--ring)'
    },
    '.cm-button': {
      height: '24px',
      padding: '0 10px',
      borderRadius: '4px',
      border: '1px solid var(--border)',
      backgroundColor: 'var(--background)',
      backgroundImage: 'none',
      color: 'var(--foreground)',
      fontFamily: 'var(--font-sans)',
      fontSize: '11px',
      cursor: 'pointer'
    },
    '.cm-button:hover': {
      backgroundColor: 'var(--muted)'
    },
    '.cm-button:focus': {
      borderColor: 'var(--ring)',
      outline: 'none',
      boxShadow: '0 0 0 1px var(--ring)'
    },
    '.cm-button[name="close"]': {
      marginInlineStart: 'auto',
      width: '24px',
      padding: 0
    },
    '.cm-searchMatch': {
      backgroundColor: 'color-mix(in oklch, var(--ring) 32%, transparent)',
      borderRadius: '2px'
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'color-mix(in oklch, var(--ring) 60%, transparent)'
    },
    // Scrollbars: blend into the editor instead of the OS default white track.
    '.cm-scroller::-webkit-scrollbar': {
      width: '10px',
      height: '10px'
    },
    '.cm-scroller::-webkit-scrollbar-track': {
      background: 'transparent'
    },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      backgroundColor: 'color-mix(in oklch, var(--muted-foreground) 35%, transparent)',
      borderRadius: '6px',
      border: '2px solid transparent',
      backgroundClip: 'content-box'
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
      backgroundColor: 'color-mix(in oklch, var(--muted-foreground) 55%, transparent)',
      backgroundClip: 'content-box'
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
