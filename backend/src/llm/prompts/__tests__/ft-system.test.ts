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

describe('ft-system myth-b4xt tool/bookkeeping silence', () => {
  const render = (): string =>
    loadPrompt('session', 'ft-system', { ft_context: 'FTCTX', party_roster: 'Arin, Bryn' })

  it('states that tools resolve silently — machinery is invisible to the player', () => {
    const p = render()
    expect(p).toMatch(/Tools Resolve Silently/i)
    expect(p).toMatch(/invisible machinery|never the gears/i)
  })

  it('bars narrating the tool-call decision, resource bookkeeping, and rules deliberation', () => {
    const p = render()
    // The three leak classes observed in the MYT-69/70 smokes, verbatim-ish.
    expect(p).toMatch(/let the scene breathe/i)
    expect(p).toMatch(/first-level slot|spend that one/i)
    expect(p).toMatch(/rules deliberation|difficult terrain|by the rules/i)
  })

  it('prescribes the remedy: resolve the tool, then narrate only the fiction/outcome', () => {
    const p = render()
    expect(p).toMatch(/write ONLY what happens in the world|narrates how it lands/i)
    expect(p).toMatch(/let the FICTION carry it/i)
  })

  it('echoes the silence rule in the Critical Rules list', () => {
    const p = render()
    expect(p).toMatch(/Tools resolve silently\./)
    expect(p).toMatch(/the fiction shows outcomes, not the machinery/i)
  })
})

describe('ft-system player-agency in multiplayer (myth-ph544)', () => {
  const render = (): string =>
    loadPrompt('session', 'ft-system', { ft_context: 'FTCTX', party_roster: 'Arin, Bryn' })

  it('states that each player character belongs to its own player, never the DM', () => {
    const p = render()
    expect(p).toMatch(/belong[s]? to (its own|their) player/i)
    expect(p).toMatch(/never voice a player character|you never voice a player/i)
  })

  it('forbids authoring the addressed PC when one character addresses another', () => {
    const p = render()
    // the cross-address case must be named explicitly, not just the generic rule
    expect(p).toMatch(/addresses another|one character addresses/i)
    expect(p).toMatch(/hold the (beat|floor)|leave the floor/i)
  })

  it('enumerates the five things the DM must never do to another PC', () => {
    const p = render()
    expect(p).toMatch(/put words in a player character'?s mouth/i)
    expect(p).toMatch(/move a player character'?s body|move .* body/i)
    expect(p).toMatch(/equipment|possessions/i)
    expect(p).toMatch(/roll a check for an action .* did not declare/i)
  })

  it('honors a player reclaiming/correcting a detail about their own character', () => {
    expect(render()).toMatch(/reclaim|corrects a detail/i)
  })

  it('bars the DM from emitting the "CharacterName:" attributed input format', () => {
    const p = render()
    expect(p).toMatch(/how players speak to you|players'? input/i)
    expect(p).toMatch(/never begin a line with a character'?s name|never .* attributed format/i)
  })

  it('does not weave a response to an action a silent character has not taken', () => {
    expect(render()).toMatch(/has not acted|silent character|did not take/i)
  })

  it('holds the floor even when a question demands a PC\'s expertise, and bars tools on their behalf', () => {
    const p = render()
    expect(p).toMatch(/demand[s]? a particular character'?s knowledge|expert read belongs/i)
    expect(p).toMatch(/lore tool|lore lookup|knowledge check/i)
  })
})

describe('ft-system ux-run1 prose amendments', () => {
  const render = (): string =>
    loadPrompt('session', 'ft-system', { ft_context: 'FTCTX', party_roster: 'Arin, Bryn' })

  it('forbids naming the scaffolding in prose, calling out "session context" (myth-eehro)', () => {
    const p = render()
    expect(p).toMatch(/never name the scaffolding/i)
    expect(p).toContain('session context')
    expect(p).toMatch(/stage direction/i)
  })

  it('permits inline emphasis but bars other markdown formatting (myth-5syk3)', () => {
    const p = render()
    expect(p).toMatch(/\*italics\*|\*bold\*|\*\*bold\*\*/i)
    expect(p).toMatch(/close every marker/i)
    expect(p).toMatch(/no other formatting|never headings/i)
  })
})
