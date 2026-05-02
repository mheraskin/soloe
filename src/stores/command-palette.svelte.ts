export type CommandPaletteMode = 'commands' | 'open-project';

class CommandPaletteStore {
  isOpen = $state(false);
  mode = $state<CommandPaletteMode>('commands');

  open(mode: CommandPaletteMode = 'commands'): void {
    this.mode = mode;
    this.isOpen = true;
  }

  show(): void {
    this.open();
  }

  close(): void {
    this.isOpen = false;
    this.mode = 'commands';
  }

  toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }
}

export const commandPalette = new CommandPaletteStore();
