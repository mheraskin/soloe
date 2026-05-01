class DiagnosticsPaneStore {
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

export const diagnosticsPane = new DiagnosticsPaneStore();
