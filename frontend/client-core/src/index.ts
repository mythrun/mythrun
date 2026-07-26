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
// MYT-90 character-creation API layer (B2): the per-player character routes as
// imperative client-core slices. `setStartingLevel` lives in its own module.
export {
  submitCharacter,
  getCharacters,
  getCharacter,
  getCharacterCreationProgress,
  finalizeCharacterCreation,
  resetCharacterConcept,
  confirmCharacter,
} from './api/characters.ts'
export type {
  SubmitCharacterBody,
  GuidedChoicesPayload,
  SubmitCharacterResponse,
  PartyRoster,
  CharacterFull,
  CharacterCreationProgress,
  FinalizeResult,
} from './api/characters.ts'
export { setStartingLevel } from './api/starting-level.ts'
export { synthesizePreview, reworkPreview, createCampaign } from './api/campaign-create.ts'
// myth-umggn: the STREAMED guided synthesis — the world brief writing itself.
// `startSynthesisStream` opens the one-shot SSE POST; `useSynthesisState` is
// the React read seam over its per-stream store (flows never import zustand).
export { startSynthesisStream, useSynthesisState } from './api/synthesize-stream.ts'
export type {
  SynthesisStream,
  SynthesisStreamState,
  SynthesisFailureCode,
} from './api/synthesize-stream.ts'

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
// The FREEFORM sibling's draft (myth-5fi4q) — the typed world concept, persisted
// so the two paths through the create screen treat the player's words alike. Store
// INJECTED per-route (the character-draft shape), not configure-once.
export {
  WORLD_CONCEPT_DRAFT_KEY,
  readWorldConceptDraft,
  writeWorldConceptDraft,
  clearWorldConceptDraft,
  useWorldConceptDraft,
} from './create/world-concept-draft.ts'
export type { WorldConceptDraftHandle } from './create/world-concept-draft.ts'
export { getBalance, useBalance } from './api/billing.ts'
export { useInvalidateBalance } from './api/billing.ts'
export { useLowSessionCredits } from './api/billing.ts'
// MYT-92 play-session slice: start (200/409/402 arms surface as HttpError for
// the start-flow classifier) + the /active lookup the 409-join path needs.
export { startSession, getActiveSession } from './api/play-session.ts'
export type { ActiveSession, ActiveSessionResponse, InsufficientCreditsBody } from './api/play-session.ts'
// myth-lhp99 post-play recap read: the campaign's latest ended session's
// secret-free close-out; the hook polls while the async analysis is pending.
export { getSessionRecap, useSessionRecap } from './api/session-recap.ts'
export type { SessionRecap, SessionRecapResponse } from '@mythrun/contract/rest'
// MYT-92 prep-status hook: the "DM is preparing" beat's brain (snapshot +
// live prep-started/ready/failed events over the shipped SSE status client).
export { useSessionPrep } from './session/use-session-prep.ts'
export type { SessionPrepStream, SessionPrepDeps } from './session/use-session-prep.ts'
// The session-prep countdown baseline (MYT-102 loading revamp): the coarse
// wall-clock estimate the between-sessions "preparing" hold feeds into
// `waitDisplay`. Session prep is a single stage with no per-stage client signals,
// so this derives from the historical prep-duration baseline. Pure data.
export { remainingSessionPrepWaitMs, SESSION_PREP_STAGE_PREFIX } from './session/session-prep-eta.ts'
// MYT-92 start flow: the ZFC-exempt structural classifier over the start
// arms + the async start/join state machine. PurchaseMoment is the
// cross-issue seam MYT-95's PurchasePrompt consumes.
export { useSessionStart, classifyStartError } from './session/start-flow.ts'
export type { StartFlow, StartOutcome, PurchaseMoment } from './session/start-flow.ts'
// MYT-92 optimistic own-messages: pending model + FIFO reconcile over the
// reducer (incl. reconnect-batch echoes via the applyReconnect folder seam).
export { addPending, reduceFrameReconciling, unconfirmedPending } from './session/optimistic.ts'
// MYT-92 useSession: the play view-model — transcript + presence + connection
// over the shipped WS transport (seedLastSeq 0 first join; batch-triggered
// confirm-or-resend; thinking clears on turnId-matched delta/end/error).
export { useSession } from './session/use-session.ts'
export type { SessionView, SessionParams, SessionDeps } from './session/use-session.ts'
// myth-atxhx session progress: the coarse BAND the play surface renders (the
// cost-derived fraction never reaches the screen) + the single threshold that
// gates the voluntary end control. Withholding is the default: no signal, no
// band, no end control.
export { progressBand, canOfferEnd, frameProgressFraction, END_CONTROL_FRACTION } from './session/session-progress.ts'
export type { SessionProgressBand } from './session/session-progress.ts'
// MYT-93 roll-reveal brain: the presentation-only dice/skill-check reveal
// reducer + phase/gate selectors (client-core computes the RollRevealView the
// web route threads into MessageStream; no UI-side runtime import — R1).
export { useRollReveal, buildRevealView } from './session/roll-reveal.ts'
export type { RollPhase, RollRevealState, RollRevealView, CardItem } from './session/roll-reveal.ts'
// ux-run3 transcript-presentation: the pure DISPLAY derivations the play route
// passes to MessageStream as plain data — the released-card causal slot
// (myth-twraw), the @dm table-talk grouping (myth-1msig), and the shared
// DM_TOKEN the composer + grouping key on.
export { DM_TOKEN, isDmSummon, orderForDisplay, buildTableTalkView } from './session/transcript-presentation.ts'
export type { TableTalkView } from './session/transcript-presentation.ts'
// ux-run3 named-entities (myth-ry14g): who the live session has actually named,
// accumulated from settled DM prose through the SAME mechanical matcher that
// underlines names in the transcript — the transcript half of the wiki index's
// presence split.
export { useNamedEntities, accumulateNamedEntities, emptyNamedEntities } from './session/named-entities.ts'
export type { NamedEntitiesState } from './session/named-entities.ts'
// MYT-91 invite slices: the shipped MYT-75 invite routes as declarative
// client-core endpoints (create/list/revoke/preview/accept) + the idempotent
// `ensurePrimaryInvite` (list → the primary share link, else mint one).
export {
  createInvite,
  listInvites,
  revokeInvite,
  previewInvite,
  acceptInvite,
  ensurePrimaryInvite,
} from './api/invites.ts'
export type { Invite, InviteListItem, InvitePreview, AcceptResult } from './api/invites.ts'
// MYT-91 arm mapping + join-path helpers: typed-code -> calm-notice arms
// (ZFC-exempt structural mapping) + the guarded returnTo path builders.
export { mapAcceptError, mapPreviewError, signinReturnToJoin, joinPath } from './invites/accept-arm.ts'
export type { AcceptArmKind, PreviewArmKind } from './contract/invite/types.ts'
// MYT-91 live roster: folds character_creation_complete off the campaign
// status SSE + reloads on each reconnect; the web foreground refetch is the
// pre-finalize fallback.
export { useLiveRoster } from './invites/use-live-roster.ts'
export type { LiveRosterDeps, ProgressState } from './invites/use-live-roster.ts'
// MYT-95 billing slices: catalog/history reads (suspense) + the three
// redirect/mutation posts; upgradeTier surfaces the 409
// upgrade_already_pending arm as its typed HttpError, never remapped.
export {
  getSkus,
  useSkus,
  getHistory,
  useHistory,
  createCheckout,
  openPortal,
  upgradeTier,
} from './api/billing.ts'
export type { CheckoutBody, PortalBody, UpgradeTierBody } from './api/billing.ts'
// MYT-95 billing brains: the tier catalogue (three named tiers, rank for
// the CTA gate, no best-value flags by register rule) + the two-bucket
// balance view (session/worldGen independent — never conflated).
export { subscriptionTiers, aLaCarteSkus, tierRank } from './billing/tier-catalogue.ts'
export { balanceView } from './billing/balance-view-model.ts'
export type { BalanceView } from './billing/balance-view-model.ts'
// The subscription CTA gate — the blind-review showstopper criterion: an
// active subscriber can NEVER reach plain subscription checkout (property-
// pinned in its test for every non-null subscription state).
export { subscriptionCta } from './billing/subscription-cta.ts'
export type { SubscriptionCta, TierCtaDecision } from './billing/subscription-cta.ts'
// MYT-95 purchase-moment brains: history prose facts (only what the feed
// sources), the 402 seam guard + prompt model (owner/non-owner), and the
// checkout-return poll with its calm non-error terminal states.
export { purchaseHistoryView } from './billing/purchase-history-view-model.ts'
export type { HistoryRowView } from './billing/purchase-history-view-model.ts'
export { isInsufficientCredits, purchasePromptModel } from './billing/insufficient-credits.ts'
export type { InsufficientCreditsError, PurchasePromptModel } from './billing/insufficient-credits.ts'
export { useCheckoutReturn } from './billing/use-checkout-return.ts'
export type { CheckoutReturnStatus } from './billing/use-checkout-return.ts'
export { createSession, refreshSession, logout } from './api/session.ts'
// Dev-tooling: the dev/staging-only API-cost ticker read (never answers in prod).
export { getDevApiCost } from './api/dev-cost.ts'
export type { DevApiCostResponse } from './api/dev-cost.ts'

// REST domain types (z.infer from the @mythrun/contract response schemas),
// re-exported so screens read the shape of a hook's data off the SAME barrel
// they call the hook through — never reaching into @mythrun/contract directly
// (R5: route/feature code imports @mythrun/client-core, @mythrun/ui, i18n only).
export type { CampaignSummary, MyCampaignsResponse } from '@mythrun/contract/rest'
export type { MeResponse } from '@mythrun/contract/rest'
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
export type { SkuListing, BillingHistoryEvent, LookupKey } from '@mythrun/contract/rest'
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

// World-gen countdown (MYT-89 audit ③ + the waiting-feedback upgrade): the
// stage-timings endpoint + the pure remaining-wait math the generating view
// ticks into a per-second `~M:SS` countdown. `StageTiming`/
// `StageTimingsResponse` re-export the wire shape off the same barrel so a
// consumer reads the endpoint + its type from one place.
export { getStageTimings } from './api/worldgen.ts'
export { remainingPrepWaitMs, remainingWaitMs } from './worldgen/stage-eta.ts'
export type { StageTiming, StageTimingsResponse } from '@mythrun/contract/rest'

// The shared waiting-display brain (MYT-102 loading revamp): the coarse
// minute-granular bucket + the estimate/stalled/hidden decision that BOTH
// waiting surfaces (character-loading + world-gen) render, sitting on top of the
// adaptive remaining-ms estimate above. Pure data — the web layer owns the tick,
// the copy, and which kinds it shows.
export { coarseWaitBucket, waitDisplay } from './loading/wait-estimate.ts'
export type { WaitBucket, WaitDisplay, WaitDisplayInput } from './loading/wait-estimate.ts'
export { clampEtaMonotonic } from './loading/monotonic-eta.ts'
export { bucketMinutes, dampEta, dampedBucket } from './loading/eta-damping.ts'
export type { DampedEta } from './loading/eta-damping.ts'
export { worldGenAccretion } from './loading/wait-accretion.ts'

// Wiki-reveal timing (MYT-89 reveal timing): the pure predicates the
// campaign-detail route reads off the stream's folded `stages[]` —
// `connectionsDone` fires the generating → reveal transition the moment
// connection-weaving completes; `completedTailStageCount` is the reveal's
// quiet wiki-refetch token as the silent tail stages land.
export { completedTailStageCount, connectionsDone } from './worldgen/reveal-timing.ts'

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

// Knowledge cache (MYT-94): ONE member-readable world-snapshot fetch → the three
// in-session projections (wiki view model / graph seed / entity index), with a
// boundary-only refetch. `frameRefetchesCache`/`CACHE_PROMOTION_FRAME_TYPES` are
// the executable enforced-ignorance invariant (no session frame promotes the
// cache). `GraphSeed` is re-exported by the worldgen slice (Task 4), not here.
export {
  useKnowledgeCache,
  frameRefetchesCache,
  CACHE_PROMOTION_FRAME_TYPES,
} from './session/knowledge-cache.ts'
export type {
  KnowledgeCache,
  KnowledgeCacheDeps,
  SnapshotToGraph,
} from './session/knowledge-cache.ts'

// In-session sheet (MYT-94): the viewer's own CuratedSheet + a live CharacterOverlay
// folded from their ledger_update frames (authoritative SET semantics — see
// ledger-reducer.ts). `adaptSheet` is injected until the raw→sheet adaptation is
// promoted out of the character-new web route.
export { useSessionSheet } from './session/use-session-sheet.ts'
export type {
  SessionSheetState,
  SessionSheetDeps,
  AdaptSheet,
  FetchRoster,
  FetchCharacter,
} from './session/use-session-sheet.ts'
export { reduceLedger, emptyOverlay } from './session/ledger-reducer.ts'
export type { CharacterOverlay, LedgerUpdateFrame } from './session/ledger-reducer.ts'
