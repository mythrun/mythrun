// Web realization of the docked-panel width persistence port (R1 — web globals
// are allowed ONLY under src/platform/web/**). The resizable side panels (the
// character-create wiki rail, the play knowledge rail) let the reader drag their
// width; this persists the chosen px width by key so it survives navigation.
//
// Wrapped like the other web stores (character-draft-store.ts): a disabled or full
// store (Safari private mode historically threw on setItem; quota-exceeded
// anywhere) degrades to non-persistent rather than throwing into a route. Clamping
// to a panel's own min/max stays with the CALLER (the bounds live with the panel).

/** The persisted width (px) for `key`, or `fallback` when absent / unreadable /
 *  non-numeric. Raw — the caller clamps to its own floor/ceiling. */
export function readPanelWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Persist the chosen width (px) for `key` (best-effort — a throw just means it
 *  won't stick). */
export function writePanelWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(Math.round(width)))
  } catch {
    // Private mode / quota exceeded — degrade to non-persistent, never crash.
  }
}
