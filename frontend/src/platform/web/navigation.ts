// Web realization of the "navigate the browser to an external URL" capability —
// the full-page redirect to the Cognito Hosted UI that the OAuth sign-in needs.
// Lives under src/platform/web/** (the sanctioned web-globals carve-out); the
// sign-in screen consumes this helper instead of touching `window.location`
// itself (R1 — screens stay DOM-free). A native shell uses an in-app browser
// session (ASWebAuthenticationSession) behind the same intent.
export function redirectTo(url: string): void {
  window.location.assign(url)
}

// The current page origin / full URL — the web realizations of "where the app is
// running". The Sessions & Billing surface (MYT-95) reads these to build the
// Stripe Checkout success/cancel return URLs (`${origin}/billing/return|cancelled`)
// and the Customer Portal `return_url` (the current page). They live here in the
// sanctioned web-globals carve-out so the screen stays DOM-free (R1); a native
// shell supplies its own deep-link base behind the same intent.
export function currentOrigin(): string {
  return window.location.origin
}
export function currentHref(): string {
  return window.location.href
}
