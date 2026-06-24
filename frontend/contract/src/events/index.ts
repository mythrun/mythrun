// Barrel for the realtime event-union contract. Re-exports the WebSocket
// session-transport frames (session-events) and the prep-pipeline SSE event
// unions (pipeline-events). Both modules are self-contained (zero internal
// imports) and were moved here verbatim from backend/src/contract in MYT-83;
// the backend now consumes them via `@mythrun/contract/events`.
export * from './session-events.js'
export * from './pipeline-events.js'
