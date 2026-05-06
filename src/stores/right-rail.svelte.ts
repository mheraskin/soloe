export type RailTabId = 'inspector' | 'notes' | 'diff';

class RightRailStore {
  activeTab = $state<RailTabId>('inspector');
  open = $state(false);

  openTab(tab: RailTabId): void {
    this.activeTab = tab;
    this.open = true;
  }

  toggleTab(tab: RailTabId): void {
    if (this.open && this.activeTab === tab) {
      this.open = false;
      return;
    }
    this.activeTab = tab;
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

export const rightRail = new RightRailStore();
