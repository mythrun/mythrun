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

describe('ft-system MYT-70 resource-ledger guidance', () => {
  const render = (): string =>
    loadPrompt('session', 'ft-system', { ft_context: 'FTCTX', party_roster: 'Arin, Bryn' })

  it('scopes the debit tools to tracked, scarce resources and exempts improvised objects (the rock)', () => {
    const p = render()
    expect(p).toMatch(/spend_resource/)
    expect(p).toMatch(/\brock\b/i)
    expect(p).toMatch(/improvised|environmental/i)
    expect(p).toMatch(/narrate (?:them|those) freely/i)
  })

  it('keeps the kept-object path (acquire) while dropped scenery stays untracked', () => {
    const p = render()
    expect(p).toMatch(/acquire_resource/)
    expect(p).toMatch(/dropped scenery stays untracked/i)
  })

  it('states the three-branch miss guidance including the no-environmental-fireball rule for spells', () => {
    const p = render()
    expect(p).toMatch(/granted it/i)
    expect(p).toMatch(/correct (?:them )?gently/i)
    expect(p).toMatch(/no environmental fireball/i)
  })

  it('states the sanctioned narrow gold-recovery rule (transcript-evidenced only)', () => {
    const p = render()
    expect(p).toMatch(/transcript-evidenced/i)
    expect(p).toMatch(/never to fund a purchase the fiction didn't/i)
  })

  it('makes binding constraints authoritative (narrate how it falls short, never a success)', () => {
    const p = render()
    expect(p).toMatch(/binding/i)
    expect(p).toMatch(/never (?:narrate )?a success/i)
  })

  it('states actor scoping (only the acting player\'s character absent table consent)', () => {
    const p = render()
    expect(p).toMatch(/acting player'?s character/i)
    expect(p).toMatch(/table consent/i)
  })

  it('states the sub-gp posture (copper-scale color, ledger moves at gp granularity)', () => {
    const p = render()
    expect(p).toMatch(/copper-scale/i)
    expect(p).toMatch(/gp granularity/i)
  })

  it('states the rest cadence (no back-to-back long rests)', () => {
    expect(render()).toMatch(/no back-to-back long rests/i)
  })

  it('honestly defers the untracked mechanics (prepared-swap, temp HP, item charges)', () => {
    const p = render()
    expect(p).toMatch(/temporary HP|temp HP/i)
    expect(p).toMatch(/item charges/i)
    expect(p).toMatch(/not tracked|defer/i)
  })

  it('explains the party-ledger block and the canonical-names rule', () => {
    const p = render()
    expect(p).toMatch(/\[Party ledger:/)
    expect(p).toMatch(/canonical/i)
    expect(p).toMatch(/reuse them exactly/i)
  })
})
