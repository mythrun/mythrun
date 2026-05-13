export const RETRY_DELAYS_MS = [200, 500, 1000, 2000] as const

export interface WaitForOptions {
  readonly label: string
  readonly probe: () => Promise<unknown>
  readonly signal?: AbortSignal
}

export async function waitFor(opts: WaitForOptions): Promise<void> {
  const { label, probe, signal } = opts
  if (signal?.aborted) {
    throw new Error(`waitFor(${label}): aborted before first attempt`)
  }
  const totalAttempts = RETRY_DELAYS_MS.length + 1
  let lastError: unknown
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    /* c8 ignore next 3 — mid-loop abort check: an external caller would
       have to abort between sleepWithAbort resolving and the next
       iteration starting, which is the same microtask cycle. The earlier
       pre-loop check (line 11) catches "aborted on entry"; sleepWithAbort's
       own listener catches "aborted during sleep". This check is the
       defense-in-depth third arm for race shapes that can't be staged in
       a unit test. */
    if (signal?.aborted) {
      throw new Error(`waitFor(${label}): aborted`)
    }
    try {
      await probe()
      return
    } catch (err) {
      lastError = err
      if (attempt === totalAttempts - 1) break
      const delay = RETRY_DELAYS_MS[attempt] ?? 0
      await sleepWithAbort(delay, signal)
    }
  }
  const cause = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `waitFor(${label}): exhausted ${String(totalAttempts)} attempts; last error: ${cause}`,
  )
}

function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('aborted during backoff sleep'))
      }
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('aborted during backoff sleep'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
