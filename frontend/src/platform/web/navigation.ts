// Web realization of the "navigate the browser to an external URL" capability —
// the full-page redirect to the Cognito Hosted UI that the OAuth sign-in needs.
// Lives under src/platform/web/** (the sanctioned web-globals carve-out); the
// sign-in screen consumes this helper instead of touching `window.location`
// itself (R1 — screens stay DOM-free). A native shell uses an in-app browser
// session (ASWebAuthenticationSession) behind the same intent.
export function redirectTo(url: string): void {
  window.location.assign(url)
}
