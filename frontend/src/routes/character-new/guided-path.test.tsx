import { describe, expect, it, vi } from 'vitest'
import { screen, cleanup, fireEvent, within } from '@testing-library/react'
import { flattenToConceptText } from '@mythrun/client-core/character'
import {
  registerGuidedPathTestHooks,
  renderGuided,
  makeDraftStore,
  question,
  pickOption,
  next,
  answerAndContinue,
  subclassStatement,
  q,
  GROUNDING,
  SHORT,
  SITUATION,
  CAMPAIGN_ID,
} from './guided-path.fixtures.tsx'

// The GUIDED PATH (MYT-90, D4) — the "answer a few questions" fork. These tests
// drive the controlled builder (a thin driver over the client-core guided reducer)
// and assert: the ordered Class→Subclass→Species→Background→Notes sequence advances;
// the conditional Subclass step is SKIPPED when the party's starting level is below
// the class's subclass level and SHOWN once it reaches it; the completed picks
// flatten (via `flattenToConceptText`) into the conceptText; and a full run submits
// conceptText + situationGroundingText + the structured guidedChoices. The reducer
// owns the sequence + the skip; this suite is the wiring's behaviour contract.
// (The ux-run2 decision-criteria/chrome additions live in the sibling
// guided-path.ux-run2.test.tsx; the shared harness in guided-path.fixtures.tsx.)

registerGuidedPathTestHooks()

describe('GuidedPath — the guided builder sequence', () => {
  it('advances Class → Subclass → Species → Background → Notes', () => {
    const { container } = renderGuided({ startingLevel: 3 })

    expect(question()).toBe(q('characterCreate.guided.class.question'))
    pickOption(container, 'fighter')
    next()

    // Level 3 Fighter gains a subclass: a statement with consent (myth-mttu7) —
    // the sole card arrives preselected, so Continue is the single act.
    expect(question()).toBe(subclassStatement('Champion', 'Fighter'))
    expect(
      container.querySelector('[data-option-id="Champion"]')?.getAttribute('aria-pressed'),
    ).toBe('true')
    next()

    expect(question()).toBe(q('characterCreate.guided.species.question'))
    pickOption(container, 'Human')
    next()

    expect(question()).toBe(q('characterCreate.guided.background.question'))
    pickOption(container, 'Soldier')
    next()

    // Notes is a freeform text step (not an option grid).
    expect(screen.queryByTestId('guided-builder')).toBeNull()
    expect(screen.getByText(q('characterCreate.guided.notes.prompt'))).toBeDefined()
  })

  it('SKIPS the Subclass step when the party level is below the class subclass level', () => {
    // Fighter gains its subclass at level 3; at level 1 the step is skipped.
    const { container } = renderGuided({ startingLevel: 1 })
    pickOption(container, 'fighter')
    next()

    // Straight to Species — no Subclass rung, no Subclass question.
    expect(question()).toBe(q('characterCreate.guided.species.question'))
    expect(
      within(screen.getByTestId('guided-builder-rail')).queryByText('Subclass'),
    ).toBeNull()
  })

  it('SHOWS the Subclass step when the party level meets the class subclass level', () => {
    // Cleric gains its subclass at level 1, so even a level-1 party sees it.
    const { container } = renderGuided({ startingLevel: 1 })
    pickOption(container, 'cleric')
    next()

    expect(question()).toBe(subclassStatement('Life Domain', 'Cleric'))
    // The rail never grows a SUBCLASS station (myth-udhp3): the sub-question
    // keeps the CLASS rung current, carrying the chosen class.
    const rail = within(screen.getByTestId('guided-builder-rail'))
    expect(rail.queryByText('Subclass')).toBeNull()
    expect(rail.getByText('Cleric').closest('[data-state]')?.getAttribute('data-state')).toBe('now')
  })

  it('steps back over an advance (Species → back → Subclass, re-selected)', () => {
    const { container } = renderGuided({ startingLevel: 3 })
    pickOption(container, 'fighter')
    next()
    pickOption(container, 'Champion')
    next()

    expect(question()).toBe(q('characterCreate.guided.species.question'))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(question()).toBe(subclassStatement('Champion', 'Fighter'))
    // The prior pick is re-selected, so Next works without re-clicking.
    expect(container.querySelector('[data-option-id="Champion"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    )
  })
})

describe('GuidedPath — grounding + submit', () => {
  /** Drive the level-3 Fighter builder up to the notes step, then optionally past
   *  it, leaving the caller at the grounding prompt. */
  function buildToGrounding(container: HTMLElement, notes: string): void {
    pickOption(container, 'fighter')
    next()
    pickOption(container, 'Champion')
    next()
    pickOption(container, 'Human')
    next()
    pickOption(container, 'Soldier')
    next()
    // Notes step (freeform, optional) → grounding.
    answerAndContinue(notes)
  }

  it('flattens the picks into conceptText via flattenToConceptText', () => {
    const { submit, container } = renderGuided({ startingLevel: 3 })
    buildToGrounding(container, '')
    // Now on grounding.
    expect(screen.getByText(q('characterCreate.freeform.groundingPrompt'))).toBeDefined()
    answerAndContinue(GROUNDING)

    const expected = flattenToConceptText(
      { className: 'fighter', subclass: 'Champion', species: 'Human', background: 'Soldier' },
      3,
    )
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(expected, GROUNDING, {
      class: 'Fighter',
      subclass: 'Champion',
      species: 'Human',
      background: 'Soldier',
    })
  })

  it('submits BOTH conceptText and situationGroundingText, then reports success', async () => {
    const { submit, onSubmitted, container } = renderGuided({ startingLevel: 3 })
    buildToGrounding(container, 'never stops counting')
    answerAndContinue(GROUNDING)

    const expected = flattenToConceptText(
      {
        className: 'fighter',
        subclass: 'Champion',
        species: 'Human',
        background: 'Soldier',
        notes: 'never stops counting',
      },
      3,
    )
    expect(submit).toHaveBeenCalledWith(expected, GROUNDING, {
      class: 'Fighter',
      subclass: 'Champion',
      species: 'Human',
      background: 'Soldier',
    })
    // onSubmitted fires after the async submit resolves.
    await vi.waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledTimes(1)
    })
  })

  // myth-gdycq — the optional pronoun ask lives on the NOTES step (the builder's
  // one free-shaped station) and joins the structured picks on the wire. Its
  // default commits to nothing, so an untouched builder submits exactly what it
  // always did.
  it('offers the pronoun ask on the notes step, defaulting to no commitment', () => {
    const { container } = renderGuided({ startingLevel: 3 })
    pickOption(container, 'fighter')
    next()
    pickOption(container, 'Champion')
    next()
    pickOption(container, 'Human')
    next()
    pickOption(container, 'Soldier')
    next()
    // Now on notes.
    expect(screen.getByTestId('pronoun-aside')).toBeDefined()
    expect(screen.getByRole('combobox').textContent).toBe(
      q('characterCreate.pronouns.unset'),
    )
  })

  it('carries a restored pronoun pick into the guidedChoices payload', () => {
    // Durable player input: seeded as a returning player's persisted draft seeds
    // it, then followed to the wire alongside the four builder picks.
    const store = makeDraftStore()
    store.set(
      `mythrun_character_draft:${CAMPAIGN_ID}`,
      JSON.stringify({ pronouns: 'she_her' }),
    )
    const { submit, container } = renderGuided({ startingLevel: 3, store })
    buildToGrounding(container, '')
    answerAndContinue(GROUNDING)

    expect(submit).toHaveBeenCalledWith(expect.any(String), GROUNDING, {
      class: 'Fighter',
      subclass: 'Champion',
      species: 'Human',
      background: 'Soldier',
      pronouns: 'she_her',
    })
  })

  it('blocks a too-short grounding answer with a calm notice (and does not submit)', () => {
    const { submit, container } = renderGuided({ startingLevel: 3 })
    buildToGrounding(container, '')
    answerAndContinue(SHORT)
    expect(screen.getByTestId('guided-notice')).toBeDefined()
    expect(submit).not.toHaveBeenCalled()
  })

  it('surfaces a calm notice and stays on the grounding step when submit fails', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('boom'))
    const { container } = renderGuided({ startingLevel: 3, submit })
    buildToGrounding(container, '')
    answerAndContinue(GROUNDING)
    expect(await screen.findByTestId('guided-notice')).toBeDefined()
    // Still on grounding — the freeform prompt is still mounted.
    expect(screen.getByText(q('characterCreate.freeform.groundingPrompt'))).toBeDefined()
  })
})

describe('GuidedPath — journey signposting + situation recap (MYT-102)', () => {
  /** Drive the level-3 Fighter builder to the NOTES step (the first builder-less
   *  screen of the journey). */
  function buildToNotes(container: HTMLElement): void {
    pickOption(container, 'fighter')
    next()
    pickOption(container, 'Champion')
    next()
    pickOption(container, 'Human')
    next()
    pickOption(container, 'Soldier')
    next()
  }

  it('keeps the rail above the notes prompt (builder gone, Notes now, Grounding todo)', () => {
    const { container } = renderGuided({ startingLevel: 3 })
    buildToNotes(container)

    expect(screen.queryByTestId('guided-builder')).toBeNull()
    const rail = within(screen.getByTestId('guided-rail'))
    expect(rail.getByText('Notes').closest('[data-state]')?.getAttribute('data-state')).toBe('now')
    expect(rail.getByText('Arrival').closest('[data-state]')?.getAttribute('data-state')).toBe('todo')
  })

  it('keeps the rail above the grounding prompt (every pick done + carried, Grounding now)', () => {
    const { container } = renderGuided({ startingLevel: 3 })
    buildToNotes(container)
    answerAndContinue('')

    // On grounding — the picks ride their done rungs (canonical values are DATA);
    // the subclass folds into the class rung's value (myth-udhp3).
    const rail = within(screen.getByTestId('guided-rail'))
    expect(rail.getByText('Fighter · Champion')).toBeDefined()
    expect(rail.getByText('Human')).toBeDefined()
    expect(rail.getByText('Soldier')).toBeDefined()
    expect(rail.getByText('Arrival').closest('[data-state]')?.getAttribute('data-state')).toBe('now')
  })

  it('holds the grounding field + its Continue in frame: detail floor, gated, cost disclosed', () => {
    // ux-run3 myth-21lpi / myth-7ceqw / myth-g3mt6 — the last screen of the
    // guided flow stacks a rail, a recap card and a long DM invitation above
    // its field, so the field takes the DETAIL floor (the essay floor walked
    // the field's own bottom edge and the commit control past a 1280x720
    // frame), Continue stands down while the field is empty, and the press
    // that spends discloses what it costs.
    const { container } = renderGuided({ startingLevel: 3, situation: SITUATION })
    buildToNotes(container)
    answerAndContinue('')

    const prompt = within(screen.getByTestId('freeform-prompt'))
    expect(prompt.getByRole('textbox').style.minHeight).toContain('3 * 1lh')
    const continueBtn = prompt.getByRole('button', { name: q('characterCreate.freeform.continue') })
    expect(continueBtn.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('freeform-submit-hint').textContent).toBe(
      q('characterCreate.freeform.cost'),
    )
  })

  it('renders the situation recap above the grounding prompt when a situation is supplied', () => {
    const { container } = renderGuided({ startingLevel: 3, situation: SITUATION })
    buildToNotes(container)
    answerAndContinue('')

    const recap = screen.getByTestId('situation-recap')
    expect(recap.textContent).toContain('A debt come due')
    expect(recap.textContent).toContain('The Salt Ledger')
    expect(recap.textContent).toContain('The counting-house wants paying.')
    // Above the prompt: the recap precedes the grounding FreeformPrompt.
    const prompt = screen.getByTestId('freeform-prompt')
    expect(recap.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders no recap on the option steps or without a chosen situation', () => {
    const { container } = renderGuided({ startingLevel: 3, situation: SITUATION })
    // Option step: the builder owns the screen — no recap.
    expect(screen.queryByTestId('situation-recap')).toBeNull()
    buildToNotes(container)
    answerAndContinue('')
    cleanup()

    // Grounding without a situation (legacy world / failed fetch): no recap.
    const bare = renderGuided({ startingLevel: 3 })
    buildToNotes(bare.container)
    answerAndContinue('')
    expect(screen.getByText(q('characterCreate.freeform.groundingPrompt'))).toBeDefined()
    expect(screen.queryByTestId('situation-recap')).toBeNull()
  })
})

describe('GuidedPath — escape hatch', () => {
  it('abandons to the freeform fork when "describe them instead" is pressed', () => {
    const { onSkipToFreeform } = renderGuided()
    fireEvent.click(screen.getByRole('button', { name: 'Describe your character instead' }))
    expect(onSkipToFreeform).toHaveBeenCalledTimes(1)
  })
})

describe('GuidedPath — back to chooser + draft persistence', () => {
  it('shows a Back on the Class step that leaves to the chooser', () => {
    const { onBack } = renderGuided()
    // One Back, one position (myth-80an1): the builder's own action-row Back is
    // present on the first step too, wired to leave to the chooser.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('rehydrates the committed picks after a back-to-chooser round-trip (shared store)', () => {
    const store = makeDraftStore()
    const first = renderGuided({ store, startingLevel: 1 })
    expect(question()).toBe(q('characterCreate.guided.class.question'))
    pickOption(first.container, 'fighter')
    next() // commit class → species (subclass skipped at L1); persisted to the draft
    cleanup()

    // Re-enter guided with the SAME store: the reducer rehydrates to the species step,
    // the class pick intact — nothing selected was lost across the chooser round-trip.
    renderGuided({ store, startingLevel: 1 })
    expect(question()).toBe(q('characterCreate.guided.species.question'))
  })

  it('persists the notes prose as it is typed', () => {
    const store = makeDraftStore()
    const { container } = renderGuided({ store, startingLevel: 1 })
    pickOption(container, 'fighter')
    next() // → species
    pickOption(container, 'Human')
    next() // → background
    pickOption(container, 'Soldier')
    next() // → notes (free text)
    const notes = within(screen.getByTestId('freeform-prompt')).getByRole<HTMLTextAreaElement>('textbox')
    fireEvent.change(notes, { target: { value: 'left-handed, keeps a raven' } })
    const raw = store.get(`mythrun_character_draft:${CAMPAIGN_ID}`)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw ?? '{}') as { guided?: { notes?: string } }
    expect(parsed.guided?.notes).toBe('left-handed, keeps a raven')
  })
})
