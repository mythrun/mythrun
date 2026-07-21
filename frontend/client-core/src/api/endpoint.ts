import type { ZodType } from 'zod'
import { ContractValidationError, HttpError, NetworkError } from './errors.ts'
import { runRefresh } from '../auth/token-manager.ts'

// `defineEndpoint` is the load-bearing primitive of the client brain: the ONLY
// sanctioned way the app reaches the backend. Every endpoint is declared with a
// method, a typed path builder, and Zod request/response schemas — contract
// conformance is structural, not a convention.
//
// MYT-84 adds the cookie-auth seam: `credentials:'include'` (threaded into the
// fetch init) + `skipAuthRetry` (the auth endpoints exempt themselves from the
// 401 refresh), and the refresh-on-401 retry itself — which lives HERE because
// it observes the RESPONSE status, which `getAuthHeaders` cannot.

/** Per-call ambient state: where the backend lives + how to authenticate. */
export interface ApiContext {
  baseUrl: string
  getAuthHeaders: () => Promise<Record<string, string>>
}

/**
 * A declarative endpoint. `In` is the caller-supplied input (defaults to `void`);
 * `Res` is the validated response type.
 */
export interface EndpointSpec<Res, In> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Builds the path (appended to `ctx.baseUrl`) from the typed input. */
  path: (input: In) => string
  /** Optional request-body schema. When present, the input is validated + sent as JSON. */
  request?: ZodType
  /** Required response schema. The parsed body is what the caller receives. */
  response: ZodType<Res>
  /** When set, threaded into the fetch RequestInit (the cookie-bearing auth calls). */
  credentials?: 'include'
  /** When true, a 401 is NOT retried via the single-flight refresh. The auth
   *  endpoints (session/refresh/logout) MUST set this — else a failed refresh
   *  would recurse through the refresh call itself. */
  skipAuthRetry?: boolean
}

async function buildInit<Res, In>(
  spec: EndpointSpec<Res, In>,
  input: In,
  ctx: ApiContext,
): Promise<RequestInit> {
  const headers = await ctx.getAuthHeaders()
  const base: RequestInit = { method: spec.method, headers }
  if (spec.credentials !== undefined) base.credentials = spec.credentials
  if (spec.request === undefined) return base
  const validated = spec.request.safeParse(input)
  if (!validated.success) {
    throw new ContractValidationError('request did not match contract', validated.error)
  }
  return {
    ...base,
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

/** Reads the typed `code` (+ raw body) off a non-2xx response. Never throws — a
 *  non-JSON / empty error body yields `{}` so the HttpError still carries status. */
async function readErrorPayload(res: Response): Promise<{ code?: string; body?: unknown }> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const code = (body as { code?: unknown }).code
      return typeof code === 'string' ? { body, code } : { body }
    }
    return { body }
  } catch {
    return {}
  }
}

function parseResponse<Res>(response: ZodType<Res>, json: unknown): Res {
  const parsed = response.safeParse(json)
  if (!parsed.success) {
    throw new ContractValidationError('response did not match contract', parsed.error)
  }
  return parsed.data
}

/**
 * Compiles an `EndpointSpec` into a caller `(input, ctx) => Promise<Res>`.
 */
export function defineEndpoint<Res, In = void>(
  spec: EndpointSpec<Res, In>,
): (input: In, ctx: ApiContext) => Promise<Res> {
  return async (input, ctx) => {
    const url = ctx.baseUrl + spec.path(input)
    let res = await send(url, await buildInit(spec, input, ctx))
    if (res.status === 401 && spec.skipAuthRetry !== true && (await runRefresh())) {
      // Refresh succeeded → rebuild the init so getAuthHeaders re-reads the
      // FRESH access token (a stale init would resend the dead Bearer), retry once.
      res = await send(url, await buildInit(spec, input, ctx))
    }
    if (!res.ok) {
      const { code, body } = await readErrorPayload(res)
      throw new HttpError(res.status, res.statusText || `HTTP ${String(res.status)}`, code, body)
    }
    if (res.status === 204) return parseResponse(spec.response, undefined)
    return parseResponse(spec.response, await res.json())
  }
}
