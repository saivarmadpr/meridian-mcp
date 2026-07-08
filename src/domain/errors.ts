/** Domain-level errors, mapped to MCP tool errors by the tool layer. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super('not_found', `${what} not found`);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super('invalid_argument', message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super('conflict', message);
  }
}
