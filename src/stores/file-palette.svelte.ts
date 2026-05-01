class FilePaletteStore {
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

export const filePalette = new FilePaletteStore();
