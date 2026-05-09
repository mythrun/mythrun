// backend/src/repo/uuidv5.ts
//
// Deterministic UUIDv5 generator (RFC 4122 §4.3). SHA-1(namespace_bytes ||
// name_bytes), first 16 bytes, with version 5 and variant 10 bits set.
//
// Used by the MYT-43 trial-burn flow to derive a stable source_id from
// (userId, creditType) — the credit_ledger.source_id column is UUID-typed,
// so a string-based key would fail the type check.
//
// Pure function; no I/O. Implementation note: we don't depend on the
// `uuid` npm package because UUIDv5 is the only flavor we need from it
// (UUIDv7 already lives in repo/uuidv7.ts), and node:crypto's SHA-1 is
// sufficient.

import { createHash } from 'node:crypto'

export function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = parseUuidToBytes(namespace)
  const nameBytes = Buffer.from(name, 'utf8')
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10
  return bytesToUuid(bytes)
}

function parseUuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`uuidv5: invalid namespace UUID: ${uuid}`)
  }
  return Buffer.from(hex, 'hex')
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}
