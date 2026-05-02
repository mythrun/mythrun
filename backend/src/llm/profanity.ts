// backend/src/llm/profanity.ts
//
// STUB. Real Haiku call lands in MYT-44 (LLM wrapper layer).
// Tracking bead: myth-urh6.
//
// Two-layer protection:
//   1. RESERVED_USERNAMES — hard impersonation roots, case-insensitive
//      exact match. List is small and grows only for specific
//      impersonation patterns we discover.
//   2. Profanity seed list (profanity-seed-en.txt) — substring match,
//      currently a curated minimal subset; canonical Shutterstock
//      LDNOOBW English list folds in before public launch.
//
// MYT-44's Haiku call wraps these as the fast-path; full LLM
// classification handles edge cases the static lists miss.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'support', 'help', 'system', 'security',
  'mythrun', 'mythrun_team', 'mythrunhq', 'official',
  'anthropic', 'anthropic_team', 'stripe', 'aws', 'cognito',
  'root', 'noreply', 'no_reply', 'me', 'null', 'undefined',
])

const here = fileURLToPath(import.meta.url)
const seedPath = resolve(here, '../profanity-seed-en.txt')
const seedList: ReadonlySet<string> = (() => {
  try {
    const raw = readFileSync(seedPath, 'utf8')
    return new Set(
      raw
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0 && !line.startsWith('#')),
    )
  } catch {
    // Seed list missing in some test environments — fall back to empty.
    // Production deployments must have the file; CI verifies on smoke test.
    return new Set<string>()
  }
})()

export interface ProfanityResult {
  readonly profane: boolean
  readonly reason?: 'reserved' | 'profane'
}

export async function classifyProfanity(text: string): Promise<ProfanityResult> {
  const lower = text.toLowerCase()

  if (RESERVED_USERNAMES.has(lower)) {
    return { profane: true, reason: 'reserved' }
  }

  for (const word of seedList) {
    if (lower.includes(word)) {
      return { profane: true, reason: 'profane' }
    }
  }

  return { profane: false }
}
