// Re-export shim. The prep-pipeline SSE event-union contract moved to the
// shared `@mythrun/contract` package (MYT-83 W0b) so the frontend client-core
// can consume the same event unions the worker produces. This file stays as a
// shim so the backend production + test import sites referencing
// `../contract/pipeline-events.js` don't churn. New code should import from
// `@mythrun/contract/events` directly.
export * from '@mythrun/contract/events'
