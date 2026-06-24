// The data layer raises three distinct failure kinds so callers can branch on
// what actually went wrong, not parse a message string:
//
//   - HttpError              a response arrived with a non-2xx status
//   - ContractValidationError  a response body failed contract (Zod) validation
//   - NetworkError           the request never produced a response (transport)
//
// All three are real Errors (proper `.name`, message, and stack), and each has
// an `instanceof`-backed type guard so the React Query / api layers can map a
// caught `unknown` to user-facing behaviour without local intelligence.

/** A non-2xx HTTP response. Carries the status the server returned. */
export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/**
 * A response whose body failed contract (Zod) validation. Carries the
 * underlying issue (typed `unknown` — the data layer never re-types a Zod
 * error as `any`) as `cause` so the failure can be logged/inspected upstream.
 */
export class ContractValidationError extends Error {
  override readonly cause: unknown

  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'ContractValidationError'
    this.cause = cause
  }
}

/** A transport-level failure — the request never produced a response. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError
}

export function isContractValidationError(e: unknown): e is ContractValidationError {
  return e instanceof ContractValidationError
}

export function isNetworkError(e: unknown): e is NetworkError {
  return e instanceof NetworkError
}
