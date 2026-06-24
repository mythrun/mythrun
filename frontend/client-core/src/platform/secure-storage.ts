// A platform-capability interface (R1): the DOM-free client brain reaches
// secure persistence through this contract, never a web global. The web impl
// (backed by the appropriate browser store) lands in W3b; a native impl
// (Keychain / Keystore) can satisfy the same surface later. All methods are
// async so the contract holds for stores that are inherently asynchronous.
export interface SecureStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
