import { Pool, type PoolConfig } from 'pg'

export function createPgPool(url: string): Pool {
  // pg does NOT auto-derive TLS from `?sslmode=require` in the URL alone.
  // Parse explicitly and set the `ssl` option so prod (RDS, sslmode=require)
  // and dev (localhost, no TLS) both work from the same call site.
  const sslMode = new URL(url).searchParams.get('sslmode')
  const config: PoolConfig = { connectionString: url }
  if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') {
    config.ssl = { rejectUnauthorized: sslMode !== 'require' }
  }
  return new Pool(config)
}
