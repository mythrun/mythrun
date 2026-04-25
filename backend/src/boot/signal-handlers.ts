const SIGNALS = ['SIGINT', 'SIGTERM'] as const satisfies readonly NodeJS.Signals[]

export function installSignalHandlers(controller: AbortController): void {
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (!controller.signal.aborted) {
        controller.abort()
      }
    })
  }
}
