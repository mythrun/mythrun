import type { ZodType } from 'zod'
import { ContractValidationError, HttpError, NetworkError } from './errors.ts'

// `defineEndpoint` is the load-bearing primitive of the client brain: the ONLY
// sanctioned way the app reaches the backend. Every endpoint is declared with a
// method, a typed path builder, and Zod request/response schemas — so contract
// conformance is structural, not a convention. A later lint bans bare `fetch`
// and react-query in screens, which leaves this as the single seam through
// which a request can leave the app. The schemas come from `@mythrun/contract`
// in real use; here they are plain `ZodType`s so the primitive stays agnostic.
//
// `fetch` is universal (web + React Native) and explicitly allowed by R1, so it
// lives directly in the brain rather than behind a platform interface.

/** Per-call ambient state: where the backend lives + how to authenticate. */
export interface ApiContext {
  baseUrl: string
  getAuthHeaders: () => Promise<Record<string, string>>
}

/**
 * A declarative endpoint. `In` is the caller-supplied input (defaults to
 * `void` for endpoints that take none); `Res` is the validated response type.
 */
export interface EndpointSpec<Res, In> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Builds the path (appended to `ctx.baseUrl`) from the typed input. */
  path: (input: In) => string
  /** Optional request-body schema. When present, the input is validated + sent as JSON. */
  request?: ZodType
  /** Required response schema. The parsed body is what the caller receives. */
  response: ZodType<Res>
}

/**
 * Builds the `RequestInit` for a call: auth headers plus, when the endpoint
 * declares a request schema, a validated JSON body (throwing
 * `ContractValidationError` BEFORE any network call if the input is malformed).
 */
async function buildInit<Res, In>(
  spec: EndpointSpec<Res, In>,
  input: In,
  ctx: ApiContext,
): Promise<RequestInit> {
  const headers = await ctx.getAuthHeaders()
  if (spec.request === undefined) {
    return { method: spec.method, headers }
  }
  const validated = spec.request.safeParse(input)
  if (!validated.success) {
    throw new ContractValidationError('request did not match contract', validated.error)
  }
  return {
    method: spec.method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(validated.data),
  }
}

/** Performs the transport, normalising any thrown/rejected fetch to `NetworkError`. */
async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (cause) {
    throw new NetworkError(cause instanceof Error ? cause.message : 'request failed')
  }
}

/**
 * Compiles an `EndpointSpec` into a caller `(input, ctx) => Promise<Res>`. The
 * returned function validates the request (if schema'd), performs the fetch,
 * maps a non-2xx response to `HttpError`, and validates the response body
 * against the contract — handing back the parsed, typed data.
 */
export function defineEndpoint<Res, In = void>(
  spec: EndpointSpec<Res, In>,
): (input: In, ctx: ApiContext) => Promise<Res> {
  return async (input, ctx) => {
    const init = await buildInit(spec, input, ctx)
    const res = await send(ctx.baseUrl + spec.path(input), init)
    if (!res.ok) {
      throw new HttpError(res.status, res.statusText || `HTTP ${String(res.status)}`)
    }
    const json: unknown = await res.json()
    const parsed = spec.response.safeParse(json)
    if (!parsed.success) {
      throw new ContractValidationError('response did not match contract', parsed.error)
    }
    return parsed.data
  }
}
