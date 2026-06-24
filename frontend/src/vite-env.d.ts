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
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
