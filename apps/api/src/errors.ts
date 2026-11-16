export type ErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION' | 'INTERNAL';

const STATUS: Record<ErrorCode, 401 | 403 | 404 | 409 | 422 | 500> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: 401 | 403 | 404 | 409 | 422 | 500;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}
