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
export { getMe, useMe } from './api/users.ts'
export { getMyCampaigns, useMyCampaigns } from './api/campaigns.ts'

// REST domain types (z.infer from the @mythrun/contract response schemas),
// re-exported so screens read the shape of a hook's data off the SAME barrel
// they call the hook through — never reaching into @mythrun/contract directly
// (R5: route/feature code imports @mythrun/client-core, @mythrun/ui, i18n only).
export type { CampaignSummary, MyCampaignsResponse } from '@mythrun/contract/rest'

// Auth seam — the injected per-request header producer.
export { getAuthHeaders } from './api/auth.ts'
export type { AuthHeaderOptions } from './api/auth.ts'

// Three-state session store (Zustand, module-level global hook).
export { useSessionStore } from './stores/session.ts'
export type { SessionStatus, SessionState } from './stores/session.ts'

// Platform-capability contracts the brain reaches through (impls are per-platform).
export type { SecureStorage } from './platform/secure-storage.ts'
