// Read/write the active dev-sub identity in localStorage and emit a
// custom event on changes so other components can re-render.
//
// DEV_SUBS is the canonical list of synthetic identities the dev tool
// offers. Future MYT-51 seed migration MUST insert exactly these rows
// in Postgres so authenticated routes work end-to-end. Five identities
// cover the 2–5 player range from spec §12.2 with one spare for solo-
// test scenarios.

const STORAGE_KEY = 'mythrun.devtool.devSub'
const EVENT = 'mythrun.identitychanged'

export const DEV_SUBS = [
  'dev-user-1',
  'dev-user-2',
  'dev-user-3',
  'dev-user-4',
  'dev-user-5',
] as const

export type DevSub = (typeof DEV_SUBS)[number]

function isDevSub(value: string): value is DevSub {
  return (DEV_SUBS as readonly string[]).includes(value)
}

export function getCurrentDevSub(): DevSub {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored !== null && isDevSub(stored)) {
    return stored
  }
  return 'dev-user-1'
}

export function setCurrentDevSub(sub: DevSub): void {
  localStorage.setItem(STORAGE_KEY, sub)
  window.dispatchEvent(new CustomEvent<DevSub>(EVENT, { detail: sub }))
}

export function onIdentityChanged(cb: (sub: DevSub) => void): () => void {
  const handler = (e: Event): void => {
    cb((e as CustomEvent<DevSub>).detail)
  }
  window.addEventListener(EVENT, handler)
  return () => {
    window.removeEventListener(EVENT, handler)
  }
}
