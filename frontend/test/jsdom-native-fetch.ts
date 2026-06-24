import { builtinEnvironments } from 'vitest/environments'
import type { Environment } from 'vitest/environments'

// A jsdom test environment that keeps Node's NATIVE Fetch-API stack instead of
// jsdom's. WHY: Node 24 bundles undici v7, whose `new Request(url, { signal })`
// brand-checks the signal against undici's own `AbortSignal`. Vitest's jsdom
// environment copies jsdom's `AbortController`/`AbortSignal` over the native
// globals, so a signal from `new AbortController()` is jsdom's and undici
// rejects it with "Expected signal to be an instance of AbortSignal". That
// breaks React-Router v7's data router under jsdom — every navigation builds a
// `Request` with an abort signal — which is exactly what the app shell's router
// tests exercise. (vitest-dev/vitest#8374; the upstream fix landed in vitest 4
// via PR #8390 — this is the same mechanism, scoped locally until we upgrade.)
//
// Mechanism: capture the native classes off `global` BEFORE the builtin jsdom
// setup runs `populateGlobal` (which shadows them with jsdom's), then re-assign
// the natives afterward. Vitest installs each global as a getter/setter pair
// where the setter wins, so assigning native values makes the getter return
// them — `Request`, `AbortController`, and the signal all come from the one
// native realm, so the brand check passes.

const FETCH_GLOBALS = [
  'fetch',
  'Request',
  'Response',
  'Headers',
  'FormData',
  'AbortController',
  'AbortSignal',
] as const

const jsdom = builtinEnvironments.jsdom

export default {
  name: 'jsdom-native-fetch',
  transformMode: 'web',
  async setup(global, options) {
    // Snapshot the native (pre-jsdom) implementations from the worker realm.
    const natives = new Map<string, unknown>()
    for (const name of FETCH_GLOBALS) {
      const value = (global as Record<string, unknown>)[name]
      if (typeof value !== 'undefined') natives.set(name, value)
    }

    const { teardown } = await jsdom.setup(global, options)

    // Re-apply the natives over jsdom's copies (the setter takes precedence).
    for (const [name, value] of natives) {
      ;(global as Record<string, unknown>)[name] = value
    }

    return { teardown }
  },
} satisfies Environment
