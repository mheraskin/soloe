import { tick } from 'svelte';
import { rightRail, type RailTabId } from '../stores/right-rail.svelte';

// Toggle a rail tab and, if it just opened, move focus into the pane's
// content so the user can start typing/clicking inside it right away.
// Intentionally does not set rightRail.focusedPaneSlot — the accent ring
// is reserved for the explicit Ctrl+; cycle gesture, while shortcut/click
// opens get the same quiet focus as clicking inside the pane.
export async function toggleRailTabAndFocus(tab: RailTabId): Promise<void> {
  const wasOpen = rightRail.openTabs.includes(tab);
  rightRail.toggleTab(tab);
  if (wasOpen) return;
  if (!rightRail.openTabs.includes(tab)) return;
  await tick();
  window.dispatchEvent(new CustomEvent('soloe:focus-pane', { detail: { tabId: tab } }));
}
