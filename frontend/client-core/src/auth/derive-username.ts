// Derive a backend-valid `username` from the player's display name — regex-valid
// BY CONSTRUCTION (spec §6), so the only retry ever needed is a genuine collision.
// The handle is a system id, never shown. Target regex (backend, len 3–20,
// first/last alphanumeric, no length-2): /^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/
//
// `randomAlnum` is injected for deterministic tests (default: real random); it
// returns an n-char lowercase-alphanumeric string (never `_`).
const MIN = 3
const MAX = 20
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function defaultRandomAlnum(n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length))
  return out
}

export function deriveUsername(displayName: string, randomAlnum: (n: number) => string = defaultRandomAlnum): string {
  // 1. lowercase → keep [a-z0-9_] → collapse underscore runs → trim edge underscores.
  let slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  // 2. empty / all-underscore → player_<rand>; else too-short → pad with alnum.
  if (slug === '') {
    slug = `player_${randomAlnum(6)}`
  } else if (slug.length < MIN) {
    slug = (slug + randomAlnum(MIN)).slice(0, MIN)
  }

  // 3. truncate to 20, then trim a trailing underscore truncation may have left.
  if (slug.length > MAX) slug = slug.slice(0, MAX).replace(/_+$/, '')

  // 4. regex-valid by construction.
  return slug
}
