// The realtime transport sub-barrel (MYT-85): the WS session client + the SSE
// status client over the shared connection primitive. Re-exports only — no logic
// lives here. The top-level `@mythrun/client-core` barrel re-exports this surface
// so flows/the harness reach the transport through the package root (R5), never a
// deep `client-core/src/realtime/*` path.

export { createWsSessionClient } from './ws-session-client.ts'
export type { WsSessionClient, WsSessionConnectOptions } from './ws-session-client.ts'

export { createSseStatusClient } from './sse-status-client.ts'
export type { SseStatusClient } from './sse-status-client.ts'

export { useConnectionState } from './connection.ts'
export type {
  ConnectionState,
  ConnectionStatus,
  ConnectionFailureReason,
} from './connection.ts'
