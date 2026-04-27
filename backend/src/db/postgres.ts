import { Pool, type PoolConfig } from 'pg'

export function createPgPool(url: string, overrides?: Partial<PoolConfig>): Pool {
  // pg does NOT reliably auto-derive TLS from `?sslmode=require` in the URL —
  // its URL parser may set `ssl: true` (default rejectUnauthorized: true)
  // and not honor an explicit `ssl` override passed alongside the URL. RDS
  // presents a chain rooted in Amazon's RSA CA which Node's default trust
  // store does NOT include, so a strict handshake fails with
  // SELF_SIGNED_CERT_IN_CHAIN even though `sslmode=require` only requires
  // encryption, not chain validation.
  //
  // Robust approach: strip sslmode from the URL before passing to pg, then
  // set the `ssl` option ourselves. Same call site works for:
  //   - dev (no sslmode → no TLS)
  //   - prod sslmode=require (encryption-only, rejectUnauthorized: false)
  //   - prod sslmode=verify-ca/verify-full (rejectUnauthorized: true; would
  //     also need a `ca:` bundle which is not enabled here yet)
  const urlObj = new URL(url)
  const sslMode = urlObj.searchParams.get('sslmode')
  urlObj.searchParams.delete('sslmode')
  const cleanUrl = urlObj.toString()

  const config: PoolConfig = { connectionString: cleanUrl }
  if (sslMode === 'require') {
    config.ssl = { rejectUnauthorized: false }
  } else if (sslMode === 'verify-ca' || sslMode === 'verify-full') {
    config.ssl = { rejectUnauthorized: true }
  }
  return new Pool({ ...config, ...overrides })
}
