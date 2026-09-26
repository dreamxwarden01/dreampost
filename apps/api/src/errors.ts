export class ApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}
