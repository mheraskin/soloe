export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
