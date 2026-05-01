class CommandPaletteStore {
  open = $state(false);

  show(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  toggle(): void {
    this.open = !this.open;
  }
}

export const commandPalette = new CommandPaletteStore();
