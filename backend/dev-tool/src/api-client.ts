// Single fetch wrapper. Uses RELATIVE paths only — Vite dev server
// proxies /api/* and /health/* to the local backend (port read from
// backend/.env.development PORT; defaults to 3000). The browser only
// ever sees same-origin requests. Sets x-mythrun-dev-sub from current
// identity on every call.
//
// All dev-tool HTTP calls go through this function. No bare fetch
// elsewhere. When SSE arrives (MYT-50), EventSource also targets a
// relative path so it's same-origin too.

import { getCurrentDevSub } from './identity.js'

export interface ApiResponse<T> {
  status: number
  ok: boolean
  body: T | null
  latencyMs: number
  error?: string
}

export async function apiCall<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  // Path guard: relative paths only. Rejects bare URLs (no leading '/')
  // AND protocol-relative URLs (leading '//'). The latter is critical:
  // fetch('//evil.com/path') resolves against the page origin's scheme
  // (becoming https://evil.com/path) and would leak the x-mythrun-dev-sub
  // header to a foreign origin.
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(
      `apiCall: path must be relative and not protocol-relative (got ${JSON.stringify(path)})`,
    )
  }

  const start = performance.now()
  const headers = new Headers(init.headers)
  headers.set('x-mythrun-dev-sub', getCurrentDevSub())
  if (typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  try {
    const res = await fetch(path, { ...init, headers })
    const text = await res.text()
    let body: T | null = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as T
      } catch {
        // Non-JSON response. Leave body null; caller diagnoses via status.
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      body,
      latencyMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    return {
      status: 0,
      ok: false,
      body: null,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
