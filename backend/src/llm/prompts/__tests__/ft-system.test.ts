import { describe, expect, it } from 'vitest'
import { loadPrompt } from '../../prompts.js'

describe('ft-system prompt (multiplayer rewrite)', () => {
  const render = (): string =>
    loadPrompt('session', 'ft-system', { ft_context: 'FTCTX', party_roster: 'Arin, Bryn' })

  it('interpolates the var contract and nothing else', () => {
    const p = render()
    expect(p).toContain('FTCTX')
    expect(p).toContain('Arin, Bryn')
    expect(p).not.toContain('{{') // no unfilled vars (no npc_seeds, no character_name)
  })
  it('uses the shipped DM-direction delimiter, not the prototype STAGE tag', () => {
    const p = render()
    expect(p).toContain('[DM direction:')
    expect(p).not.toContain('[STAGE]')
  })
  it('pins the tool protocol + the error-constraint rule', () => {
    const p = render()
    expect(p).toContain('roll_skill_check')
    expect(p).toContain('roll_dice')
    expect(p).toMatch(/never generate random numbers/i)
    expect(p).toMatch(/could not be resolved/i)
  })
})

describe('ft-system MYT-69 amendments', () => {
  const render = (): string =>
    loadPrompt('session', 'ft-system', { ft_context: 'FTCTX', party_roster: 'Arin, Bryn' })
  it('adds the NPC-authenticity section', () => {
    const p = render()
    expect(p).toMatch(/strangers/i)
    expect(p).toMatch(/small talk/i)
    expect(p).toMatch(/trust is earned/i)
  })
  it('carves out no-stakes conversation from the frequency rule', () => {
    expect(render()).toMatch(/genuine .*conversation is not.*uncertainty|chatting/i)
  })
  it('states the social-check depth rule + direction-conditionality', () => {
    const p = render()
    expect(p).toMatch(/demeanor|disposition/i)
    expect(p).toMatch(/let it go|opportunity, not an order/i)
  })
  it('describes the standalone standing-direction message form', () => {
    expect(render()).toMatch(/standing/i)
  })
})
