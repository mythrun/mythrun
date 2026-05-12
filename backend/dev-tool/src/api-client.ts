// Single fetch wrapper. Uses RELATIVE paths only — Vite dev server
// proxies /api/* and /health/* to localhost:3000, so the browser only
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
  // Path guard: relative paths only. Prevents a future bug where someone
  // passes an absolute URL and the dev-sub header leaks to another origin.
  if (!path.startsWith('/')) {
    throw new Error(`apiCall: path must start with '/' (got ${JSON.stringify(path)})`)
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
