// Type augmentation for Electron's <webview> tag. The element is registered
// by Electron at runtime (when webviewTag is enabled in webPreferences) but
// the standard HTML lib doesn't know about it.

import type { HTMLAttributes } from 'svelte/elements';

declare module 'svelte/elements' {
  interface SvelteHTMLElements {
    webview: HTMLAttributes<HTMLElement> & {
      src?: string;
      partition?: string;
      allowpopups?: boolean | string;
      useragent?: string;
      disablewebsecurity?: boolean | string;
      // Lowercased event hooks used via on:event-name in Svelte templates are
      // attached imperatively (addEventListener), so they don't need to be
      // typed here.
    };
  }
}

export interface ElectronWebview extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  isLoading(): boolean;
}
