// Prose-register shared block + include mechanism (system-wide prose fix).
//
// One shared block (`shared/prose-register.txt`) is composed into every
// prose-generating prompt via a `{{include:…}}` directive resolved by
// `resolveIncludes`. These assertions pin: (a) the include mechanism splices
// and cycle-guards; (b) every wired template actually carries the block after
// resolution and leaves no unresolved directive; (c) the block stays var-free
// so it can never accidentally interpolate.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { loadPrompt, resolveIncludes, _resetPromptCacheForTests } from '../../prompts.js'

const PROMPTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// A distinctive phrase from the block — its presence proves the splice landed.
const REGISTER_MARKER = 'portent triad'
const REGISTER_HEADING = '## Prose Register'

const readRaw = (relPath: string): string =>
  readFileSync(resolve(PROMPTS_ROOT, `${relPath}.txt`), 'utf8')

describe('resolveIncludes — shared-partial mechanism', () => {
  it('splices the shared block in place of the directive', () => {
    const out = resolveIncludes('before\n{{include:shared/prose-register}}\nafter')
    expect(out).toContain('before')
    expect(out).toContain('after')
    expect(out).toContain(REGISTER_HEADING)
    expect(out).toContain(REGISTER_MARKER)
    expect(out).not.toContain('{{include:')
  })

  it('is a no-op on text with no directive', () => {
    expect(resolveIncludes('plain text {{var}}')).toBe('plain text {{var}}')
  })

  it('throws loudly on a missing include target', () => {
    expect(() => resolveIncludes('{{include:shared/does-not-exist}}')).toThrow()
  })

  it('throws loudly on an include cycle instead of recursing forever', () => {
    // Simulate re-entry: the stack already contains the partial the text includes.
    expect(() =>
      resolveIncludes('{{include:shared/prose-register}}', ['shared/prose-register']),
    ).toThrow(/cycle/)
  })
})

describe('shared/prose-register block', () => {
  it('contains no interpolation placeholders (can never accidentally fill a var)', () => {
    expect(readRaw('shared/prose-register')).not.toContain('{{')
  })

  it('names the tells from the owner critique', () => {
    const block = readRaw('shared/prose-register')
    expect(block).toMatch(/portent triad/i)
    expect(block).toMatch(/knowing hedge/i)
    expect(block).toMatch(/depending on who you are/i)
    // The owner's own anchor example is preserved as a rewrite.
    expect(block).toMatch(/unspoken, unremarked/i)
  })

  it('carries the specificity-feint rule (three plans provenance)', () => {
    const block = readRaw('shared/prose-register')
    expect(block).toMatch(/specificity feint/i)
    expect(block).toMatch(/three plans/i)
  })

  it('carries the player-agency / interiority rule', () => {
    const block = readRaw('shared/prose-register')
    expect(block).toMatch(/interiority belongs to the player/i)
    expect(block).toMatch(/inside a player character'?s head/i)
  })

  // The tasting flight's decisive finding: the two candidates that stayed clean
  // (B positive-exemplar, F combined) were the only two carrying a passage to
  // imitate. The four rules-only candidates all reproduced the same trailing
  // personified verdict ("the only building on the block that hasn't called it
  // a night"). Naming a ban makes the model substitute a different flourish;
  // showing a passage re-anchors the sentence rhythm. Pin the exemplar so a
  // future edit can't quietly demote it back to a told rule.
  it('shows a target-register exemplar, not just rules about one', () => {
    const block = readRaw('shared/prose-register')
    expect(block).toMatch(/read it for rhythm/i)
    expect(block).toContain('The common room is low and warm.')
    expect(block).toContain('Rain has stopped, but the street still runs with it.')
    // The exemplar is framed as rhythm-not-content: the block binds 12 templates,
    // most of which are not tavern narration.
    expect(block).toMatch(/not for subject matter/i)
  })

  it('names the closing-verdict tell the rules-only candidates all produced', () => {
    const block = readRaw('shared/prose-register')
    expect(block).toMatch(/closing verdict/i)
    expect(block).toMatch(/hasn't called it a night/i)
  })

  it('scopes itself to every passage, not just the worked examples', () => {
    expect(readRaw('shared/prose-register')).toMatch(
      /applies to every passage you write, every turn/i,
    )
  })
})

describe('session-prep depth-marker example models the register', () => {
  // The prompt used to teach the disease: its worked depth marker literally read
  // "There is more to Voss than meets the eye" — the mystery-signal the shared
  // block forbids — so session-prep trained the failure it was wired to prevent.
  it('does not model mystery-signalling in its worked depth marker', () => {
    const raw = readRaw('prep/session-prep')
    expect(raw).not.toMatch(/more to Voss than meets the eye/i)
    expect(raw).not.toMatch(/hints at a life before/i)
  })

  it('directs the marker to observable conduct instead', () => {
    const raw = readRaw('prep/session-prep')
    expect(raw).toMatch(/never as an assertion that a mystery exists/i)
    expect(raw).toMatch(/counts the room before she answers/i)
    // The protocol's own function is preserved: play the weight, invent nothing.
    expect(raw).toMatch(/Do not invent what the past is/i)
  })
})

describe('every wired prompt carries the register after resolution', () => {
  it('ft-system (via loadPrompt) includes the block and leaves no directive', () => {
    _resetPromptCacheForTests()
    const p = loadPrompt('session', 'ft-system', { ft_context: 'X', party_roster: 'A, B' })
    expect(p).toContain(REGISTER_HEADING)
    expect(p).toContain(REGISTER_MARKER)
    expect(p).not.toContain('{{include:')
    expect(p).not.toContain('{{')
  })

  it('session prompts loaded via loadPrompt splice the block', () => {
    for (const name of ['retcon-author', 'post-session-analysis']) {
      const resolved = resolveIncludes(readRaw(`session/${name}`))
      expect(resolved, name).toContain(REGISTER_MARKER)
      expect(resolved, name).not.toContain('{{include:')
    }
  })

  it('prep prompts (read raw + resolveIncludes in-stage) splice the block', () => {
    const prepWired = [
      'world-and-factions',
      'locations-and-npcs',
      'starting-situation',
      'world-introduction',
      'coherence-pass',
      'character-concept',
      'character-integration',
      'session-prep', // authors ft_context — the prose the FT reads (myth: three-plans provenance)
    ]
    for (const name of prepWired) {
      const resolved = resolveIncludes(readRaw(`prep/${name}`))
      expect(resolved, name).toContain(REGISTER_MARKER)
      expect(resolved, name).not.toContain('{{include:')
    }
  })

  it('deliberately-excluded prompts do NOT carry the register', () => {
    // Pure classifiers / constraint-generators / structural extractors: the
    // register is prose styling, irrelevant to them and pure token cost.
    const excluded = [
      'session/dm-trigger-classifier',
      'session/turn-audit',
      'session/skill-check',
      'session/combat-outcome',
      'session/session-reconciler',
      'prep/character-sheet',
      'prep/world-color',
    ]
    for (const relPath of excluded) {
      expect(readRaw(relPath), relPath).not.toContain('{{include:shared/prose-register}}')
    }
  })
})
