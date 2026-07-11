import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import { flattenToConceptText } from '@mythrun/client-core/character'
import { i18n } from '../../i18n/config.ts'
import { GuidedPath } from './guided-path.tsx'

// The GUIDED PATH (MYT-90, D4) — the "answer a few questions" fork. These tests
// drive the controlled builder (a thin driver over the client-core guided reducer)
// and assert: the ordered Class→Subclass→Species→Background→Notes sequence advances;
// the conditional Subclass step is SKIPPED when the party's starting level is below
// the class's subclass level and SHOWN once it reaches it; the completed picks
// flatten (via `flattenToConceptText`) into the conceptText; and a full run submits
// BOTH conceptText + situationGroundingText (the grounding whisper reuses the
// freeform component/pattern). The reducer owns the sequence + the skip; this
// suite is the wiring's behaviour contract.

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads
// `localStorage` on mount; install a functional in-memory one (mirrors the
// sibling route tests).
class MemStorage {
  private readonly store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  get length(): number {
    return this.store.size
  }
}

// The chosen situation's invitation — the grounding step renders it verbatim as
// the second prompt's whisper (mirrors the freeform path).
const WHISPER = 'Whose debt is it, and why is it yours to pay?'
// Well over the 20-char backend floor the grounding field mirrors.
const GROUNDING = 'A debt that was never mine came due on the worst possible night.'
const SHORT = 'too short'

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemStorage(),
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

interface Overrides {
  startingLevel?: number
  submit?: (conceptText: string, situationGroundingText: string) => Promise<void>
}

function renderGuided(overrides: Overrides = {}): {
  submit: (conceptText: string, situationGroundingText: string) => Promise<void>
  onSubmitted: () => void
  onSkipToFreeform: () => void
  container: HTMLElement
} {
  const submit = overrides.submit ?? vi.fn().mockResolvedValue(undefined)
  const onSubmitted = vi.fn()
  const onSkipToFreeform = vi.fn()
  const { container } = render(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <GuidedPath
          startingLevel={overrides.startingLevel ?? 3}
          groundingWhisper={WHISPER}
          submit={submit}
          onSubmitted={onSubmitted}
          onSkipToFreeform={onSkipToFreeform}
        />
      </I18nextProvider>
    </ThemeProvider>,
  )
  return { submit, onSubmitted, onSkipToFreeform, container }
}

/** The current step's question — the GuidedBuilder's level-2 hero heading. */
function question(): string {
  return screen.getByRole('heading', { level: 2 }).textContent
}

/** Click the option card carrying `data-option-id` (the durable selector — the
 *  visible copy is [ph:] and will churn at the copy pass). */
function pickOption(container: HTMLElement, id: string): void {
  const el = container.querySelector(`[data-option-id="${id}"]`)
  if (el === null) throw new Error(`no option card for id=${id}`)
  fireEvent.click(el)
}

/** Advance the guided builder (its fixed "Next" chrome). */
function next(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
}

/** Type into the single visible FreeformPrompt (notes/grounding) + press Continue. */
function answerAndContinue(value: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } })
  fireEvent.click(within(screen.getByTestId('freeform-prompt')).getByRole('button'))
}

// The typed-key augmentation rejects a runtime `string` key; the defaultValue
// overload accepts one (the keys all exist, so the fallback never surfaces).
const q = (key: string): string => i18n.t(key, { defaultValue: key })

describe('GuidedPath — the guided builder sequence', () => {
  it('advances Class → Subclass → Species → Background → Notes', () => {
    const { container } = renderGuided({ startingLevel: 3 })

    expect(question()).toBe(q('characterCreate.guided.class.question'))
    pickOption(container, 'fighter')
    next()

    // Level 3 Fighter gains a subclass, so the conditional step is present.
    expect(question()).toBe(q('characterCreate.guided.subclass.question'))
    pickOption(container, 'Champion')
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

    expect(question()).toBe(q('characterCreate.guided.subclass.question'))
    expect(
      within(screen.getByTestId('guided-builder-rail')).getByText('Subclass'),
    ).toBeDefined()
  })

  it('steps back over an advance (Species → back → Subclass, re-selected)', () => {
    const { container } = renderGuided({ startingLevel: 3 })
    pickOption(container, 'fighter')
    next()
    pickOption(container, 'Champion')
    next()

    expect(question()).toBe(q('characterCreate.guided.species.question'))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(question()).toBe(q('characterCreate.guided.subclass.question'))
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
    expect(submit).toHaveBeenCalledWith(expected, GROUNDING)
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
    expect(submit).toHaveBeenCalledWith(expected, GROUNDING)
    // onSubmitted fires after the async submit resolves.
    await vi.waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledTimes(1)
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

describe('GuidedPath — escape hatch', () => {
  it('abandons to the freeform fork when "describe them instead" is pressed', () => {
    const { onSkipToFreeform } = renderGuided()
    fireEvent.click(screen.getByRole('button', { name: 'Describe them instead' }))
    expect(onSkipToFreeform).toHaveBeenCalledTimes(1)
  })
})
