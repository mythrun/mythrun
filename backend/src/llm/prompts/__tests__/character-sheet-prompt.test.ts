// myth-wj43: content assertions for the character-sheet prep prompt. The prompt
// and the schema (schemas/character-sheet.ts) co-evolve — the schema now
// constrains skill.name to the canonical 18, and the prompt must name those 18
// AND encode the 2014-RAW Expertise rule (rogue at L1, bard at L3) so the
// pipeline can actually produce expertise rather than the old
// {proficient:true, expertise:false} hardcode. Read the raw template (the stage
// injects vars via .replace, so loadPrompt's var contract doesn't apply here).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { CANONICAL_SKILLS } from '../../schemas/character-sheet.js'

const PROMPT = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../prep/character-sheet.txt'),
  'utf8',
)

describe('character-sheet prompt: canonical skills', () => {
  it('names every one of the 18 canonical skills the schema enforces', () => {
    for (const skill of CANONICAL_SKILLS) {
      expect(PROMPT).toContain(skill)
    }
  })

  it('tells the model tool proficiencies are NOT skills', () => {
    expect(PROMPT).toMatch(/tool profici.*are NOT skills|are NOT skills/i)
    expect(PROMPT).toMatch(/thieves' tools/i)
  })
})

describe('character-sheet prompt: Expertise rule (myth-wj43)', () => {
  it('no longer hardcodes expertise:false for every skill', () => {
    // The old prompt literally read "{name, proficient:true, expertise:false}".
    expect(PROMPT).not.toContain('expertise:false}')
  })

  it('grants the rogue exactly two expertise skills at level 1', () => {
    expect(PROMPT).toMatch(/Rogue/)
    expect(PROMPT).toMatch(/Expertise at level 1/i)
    expect(PROMPT).toMatch(/exactly two|EXACTLY TWO/i)
  })

  it('grants the bard expertise from level 3', () => {
    expect(PROMPT).toMatch(/Bard/)
    expect(PROMPT).toMatch(/Expertise at level 3/i)
  })

  it('withholds expertise from every other class', () => {
    expect(PROMPT).toMatch(/other class[^]*NO expertise|NO expertise/i)
  })

  it('requires an expertise skill to also be proficient', () => {
    expect(PROMPT).toMatch(/expertise:true MUST also have proficient:true/i)
  })
})
