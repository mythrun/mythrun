// Re-export shim. The WebSocket session-transport wire contract moved to the
// shared `@mythrun/contract` package (MYT-83 W0b) so the frontend client-core
// can consume the same frame unions the backend transport produces. This file
// stays as a shim so the ~6 backend production + test import sites referencing
// `../contract/session-events.js` don't churn. New code should import from
// `@mythrun/contract/events` directly.
export * from '@mythrun/contract/events'
