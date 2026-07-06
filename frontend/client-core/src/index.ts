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
export {
  getMyCampaigns,
  useMyCampaigns,
  getWorldSnapshot,
  resumeGeneration,
  getStartingSituations,
  chooseStartingSituation,
} from './api/campaigns.ts'
export type {
  WorldGenSnapshot,
  ResumeResult,
  StartingSituation,
  StartingSituationsResponse,
  ChooseStartingSituationResult,
} from './api/campaigns.ts'
export { synthesizePreview, reworkPreview, createCampaign } from './api/campaign-create.ts'

// Guided-create draft persistence seam (MYT-89 §11) — the DOM-free brain reaches
// sessionStorage through the injected SessionDraftStore port (web impl in
// @mythrun/web, wired once at boot via configureGuidedDraft). The guided create
// screen reads/writes the in-progress picks so a refresh re-prefills them.
export {
  configureGuidedDraft,
  readGuidedDraft,
  writeGuidedDraft,
  clearGuidedDraft,
} from './create/guided-draft.ts'
export type { SessionDraftStore, GuidedDraft, GuidedPickDraft } from './create/guided-draft.ts'
export { getBalance, useBalance } from './api/billing.ts'
export { createSession, refreshSession, logout } from './api/session.ts'
// Dev-tooling: the dev/staging-only API-cost ticker read (never answers in prod).
export { getDevApiCost } from './api/dev-cost.ts'
export type { DevApiCostResponse } from './api/dev-cost.ts'

// REST domain types (z.infer from the @mythrun/contract response schemas),
// re-exported so screens read the shape of a hook's data off the SAME barrel
// they call the hook through — never reaching into @mythrun/contract directly
// (R5: route/feature code imports @mythrun/client-core, @mythrun/ui, i18n only).
export type { CampaignSummary, MyCampaignsResponse } from '@mythrun/contract/rest'
// Campaign-create wire types the create UI (Phase B) types + branches against —
// read off THIS barrel so route/feature code never imports @mythrun/contract (R5).
// GATE_REASONS is a runtime value (the closed reject-reason set for the concept gate).
export { GATE_REASONS } from '@mythrun/contract/rest'
export type {
  SynthesizerPick,
  SynthesizePreviewRequest,
  SynthesizePreviewResponse,
  ReworkRequest,
  ReworkResponse,
  CreateCampaignRequest,
  CreateCampaignResponse,
  ConceptRejection,
  GateReason,
} from '@mythrun/contract/rest'
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

// World-gen streaming graph (MYT-89 Phase C, C5): the hook that opens the
// status SSE, folds pipeline events into nodes/edges, rehydrates from the
// world-snapshot mid-generation, and branches the failure→resume path. Lives
// under src/worldgen/ alongside the pure-data reducers/force-sim, but exported
// from THIS barrel (not the worldgen subpath): it pulls in api clients + the
// SSE transport, so it is NOT part of the DOM-free-pure-data subpath the UI
// library's WorldGenGraph imports.
export { useWorldGenStream } from './worldgen/use-worldgen-stream.ts'
export type {
  WorldGenStream,
  WorldGenStatus,
  WorldGenStreamDeps,
} from './worldgen/use-worldgen-stream.ts'

// World-gen ETA (MYT-89 audit ③): the stage-timings endpoint + the pure
// remaining-time math the generation loading bar turns into a data-driven "time
// left". `StageTiming`/`StageTimingsResponse` re-export the wire shape off the
// same barrel so a consumer reads the endpoint + its type from one place.
export { getStageTimings } from './api/worldgen.ts'
export { remainingStageMs } from './worldgen/stage-eta.ts'
export type { StageTiming, StageTimingsResponse } from '@mythrun/contract/rest'

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
