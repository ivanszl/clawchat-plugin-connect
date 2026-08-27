export class RuntimeProviderValidationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RuntimeProviderValidationError";
  }
}
