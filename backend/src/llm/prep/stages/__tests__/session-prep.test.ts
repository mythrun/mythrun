import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../prompts/prep/session-prep.txt'),
  'utf8',
)

describe('session-prep template', () => {
  it('carries placeholders + fact/entity hard exclusions + party + length + session-N framing', () => {
    expect(TEMPLATE).toContain('{{world_state}}')
    expect(TEMPLATE).toContain('{{session_number}}')
    expect(TEMPLATE).toContain('ft_context')
    expect(TEMPLATE).toContain('sd_playbook')
    expect(TEMPLATE.toLowerCase()).toContain('discoverable')
    expect(TEMPLATE.toLowerCase()).toContain('secret')
    expect(TEMPLATE.toLowerCase()).toMatch(/never name|do not name|must not appear/)
    expect(TEMPLATE.toLowerCase()).toContain('party')
    // Guard the Length contract specifically (the playbook "always shorter"
    // rule or an explicit word-count) — not a bare "word"/"length" substring
    // that incidentally matches body prose.
    expect(TEMPLATE.toLowerCase()).toMatch(/always[\s\S]{0,40}shorter|\d,?\d00 words/)
  })
})
