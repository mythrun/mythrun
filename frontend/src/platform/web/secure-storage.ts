import type { SecureStorage } from '@mythrun/client-core'

// The FIRST `platform/web` impl — it establishes the convention: a web-specific
// realization of a `client-core` platform-capability interface, living under
// `src/platform/web/**` (the one place web globals are allowed). Here the
// SecureStorage contract is satisfied over `localStorage`, async-wrapped so the
// synchronous browser store conforms to the interface's Promise-returning
// methods (a native Keychain/Keystore impl, inherently async, slots in later).
export function createWebSecureStorage(): SecureStorage {
  return {
    get: (key) => Promise.resolve(localStorage.getItem(key)),
    set: (key, value) => {
      localStorage.setItem(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      localStorage.removeItem(key)
      return Promise.resolve()
    },
  }
}
