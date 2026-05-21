// backend/dev-tool/src/shell/identity-bridge.ts
//
// myth-mbdc: single shell-level mythrun.identitychanged listener.
// The shell wires this once at mount time; subsequent identity
// switches trigger the unmount-active-panel → maybe-clear-active-
// campaign → drawer-resub → re-mount sequence orchestrated by the
// shell's onIdentityChange callback. Replaces the four panel-specific
// window-clear events (closewatch / createpanel.clear / detailspanel.
// clear / ledgerpanel.clear) from the old shell.

export interface IdentityBridgeOpts {
  readonly onIdentityChange: (sub: string) => void
}

export function installIdentityBridge(opts: IdentityBridgeOpts): () => void {
  const handler = (e: Event): void => {
    const ce = e as CustomEvent<string>
    opts.onIdentityChange(ce.detail)
  }
  window.addEventListener('mythrun.identitychanged', handler)
  return () => {
    window.removeEventListener('mythrun.identitychanged', handler)
  }
}
