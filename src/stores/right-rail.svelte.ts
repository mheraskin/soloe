export type RailTabId = 'inspector' | 'notes' | 'diff' | 'overview';

class RightRailStore {
  activeTab = $state<RailTabId>('inspector');
  open = $state(false);
  // When true, the active rail tab stretches across the main area and
  // covers the terminal. Applies to whichever tab is active, not just diff.
  fullscreen = $state(false);

  openTab(tab: RailTabId): void {
    this.activeTab = tab;
    this.open = true;
  }

  toggleTab(tab: RailTabId): void {
    if (this.open && this.activeTab === tab) {
      this.open = false;
      this.fullscreen = false;
      return;
    }
    this.activeTab = tab;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.fullscreen = false;
  }

  toggleFullscreen(): void {
    if (!this.open) this.open = true;
    this.fullscreen = !this.fullscreen;
  }
}

export const rightRail = new RightRailStore();
