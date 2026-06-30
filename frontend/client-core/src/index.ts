// The public surface of the client brain. The web shell (and a native shell
// later) imports the data/state/transport layer through the bare
// `@mythrun/client-core` specifier — never deep `client-core/src/*` paths — so
// the brain's internal file layout can change without rippling into every
// screen. This is also what R5 keys on: route/feature code may import
// `@mythrun/client-core` (this barrel), `@mythrun/ui`, and i18n, nothing else.
//
// Re-exports only — no logic lives here. Subpath exports (`/contract`, `/i18n`,
// `/tokens`) stay separate (the UI library + i18n runtime consume those without
// pulling in react-query).

// API client context — carries the resolved ApiContext down the tree.
export { ApiClientProvider, useApiContext } from './api/client-context.tsx'
export type { ApiContext, EndpointSpec } from './api/endpoint.ts'
export { defineEndpoint } from './api/endpoint.ts'

// Typed failure kinds + their instanceof guards.
export {
  HttpError,
  ContractValidationError,
  NetworkError,
  isHttpError,
  isContractValidationError,
  isNetworkError,
} from './api/errors.ts'

// Endpoint slices + the thin React-Query suspense hooks the screens render against.
export { getMe, useMe, register, checkUsername } from './api/users.ts'
export { getMyCampaigns, useMyCampaigns } from './api/campaigns.ts'
export { getBalance, useBalance } from './api/billing.ts'
export { createSession, refreshSession, logout } from './api/session.ts'

// REST domain types (z.infer from the @mythrun/contract response schemas),
// re-exported so screens read the shape of a hook's data off the SAME barrel
// they call the hook through — never reaching into @mythrun/contract directly
// (R5: route/feature code imports @mythrun/client-core, @mythrun/ui, i18n only).
export type { CampaignSummary, MyCampaignsResponse } from '@mythrun/contract/rest'
export type { BalanceResponse, ActiveSubscriptionSummary } from '@mythrun/contract/rest'
export type {
  RegisterRequest,
  RegisterResponse,
  CheckUsernameResponse,
  SessionRequest,
  SessionResponse,
  RefreshResponse,
} from '@mythrun/contract/rest'

// Auth seam — the injected per-request header producer.
export { getAuthHeaders } from './api/auth.ts'
export type { AuthHeaderOptions } from './api/auth.ts'

// In-memory access-token manager (MYT-84). The jwt getAuthHeaders + the
// defineEndpoint 401-retry read this; the app bootstrap wires configureTokenRefresh.
export {
  getAccessToken,
  setAccessToken,
  clearAccessToken,
  getAccessTokenExpiresAtMs,
  runRefresh,
  configureTokenRefresh,
} from './auth/token-manager.ts'

// Three-state session store (Zustand, module-level global hook).
export { useSessionStore } from './stores/session.ts'
export type { SessionStatus, SessionState } from './stores/session.ts'

// Session adapter — the /me → store mapping + the on-load bootstrap (MYT-84).
export { applyMe, bootstrapSession } from './auth/session-adapter.ts'
export { readSubClaim } from './auth/jwt-claims.ts'

// Onboarding helper — derive a regex-valid-by-construction `username` from the
// player's display name (the onboarding moment, MYT-84). The handle is a system
// id, never shown; the screen registers with it and re-derives only on collision.
export { deriveUsername } from './auth/derive-username.ts'

// Platform-capability contracts the brain reaches through (impls are per-platform).
export type { SecureStorage } from './platform/secure-storage.ts'

// Streamed-HTTP seam (MYT-85): the SSE status client's one platform-divergent
// dependency. The interface is DOM-free here; the web impl (fetch + ReadableStream
// + TextDecoder) lives in @mythrun/web and is wired UNCONDITIONALLY at boot via
// configureStreamingFetch (both auth modes — unlike the jwt-only token refresh).
export { configureStreamingFetch } from './platform/streaming-fetch.ts'
export type { StreamingFetch } from './platform/streaming-fetch.ts'

// Realtime transport (MYT-85): the WS session client + the SSE status client over
// the shared connection primitive (+ the React read seam useConnectionState). The
// flows + the /dev/transport harness consume these through the package root.
export {
  createWsSessionClient,
  createSseStatusClient,
  useConnectionState,
} from './realtime/index.ts'
export type {
  WsSessionClient,
  WsSessionConnectOptions,
  SseStatusClient,
  ConnectionState,
  ConnectionStatus,
  ConnectionFailureReason,
} from './realtime/index.ts'

// OAuth/PKCE helpers (MYT-84) — the canonical oauth API consumed by the sign-in +
// callback screens. State persistence + the Cognito Hosted UI config are injected
// once at boot via configureOAuth; the web store impl (sessionStorage) lives in
// @mythrun/web.
export {
  createPkce,
  createAuthState,
  consumeAuthState,
  configureOAuth,
  isLocalPath,
  buildAuthorizeUrl,
  parseCallback,
} from './auth/oauth.ts'
export type {
  OAuthProvider,
  PkcePair,
  AuthStateData,
  OAuthCognitoConfig,
} from './auth/oauth.ts'
export type { OAuthStateStore } from './platform/oauth-state-store.ts'
