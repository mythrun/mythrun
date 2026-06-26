/// <reference types="vite/client" />

// Typed `import.meta.env` for the app's custom build vars. Without this
// augmentation, `vite/client`'s `ImportMetaEnv` falls back to an `any` index
// signature, and reading `import.meta.env.VITE_*` trips strictTypeChecked's
// `no-unsafe-*` family. Each var is optional (`?`) — it may be unset in dev,
// where `main.tsx` supplies a default.
interface ImportMetaEnv {
  /** Backend base URL. Defaults to `http://localhost:3030` when unset. */
  readonly VITE_API_BASE_URL?: string
  /** The dev-bypass `sub` sent as `x-mythrun-dev-sub`. Defaults to `dev-user-1`. */
  readonly VITE_DEV_SUB?: string
  /** Cognito Hosted UI host (PUBLIC build value), e.g.
   *  `mythrun-staging.auth.us-east-1.amazoncognito.com`. Read in `main.tsx`'s jwt
   *  branch only; typed required `string` so the `configureOAuth` call is type-clean. */
  readonly VITE_COGNITO_HOSTED_UI_DOMAIN: string
  /** Cognito SPA app-client id (PUBLIC — PKCE means no client secret). Read in
   *  `main.tsx`'s jwt branch only; typed required `string` for the same reason. */
  readonly VITE_COGNITO_APP_CLIENT_ID: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
