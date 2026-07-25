import { afterEach, beforeAll, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import type { SessionDraftStore } from '@mythrun/client-core/character'
import type { GuidedChoicesPayload } from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { GuidedPath } from './guided-path.tsx'

// The shared GuidedPath test harness (the `.fixtures` naming keeps it out of the
// vitest glob — the ws-session-client precedent): the render helper, the
// step-walking helpers, and the environment hooks, consumed by the two
// guided-path suites (the core behaviour contract + the ux-run2 additions).

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

/** Register the suite's environment hooks (call once at each test module's top
 *  level): the in-memory localStorage shim + per-test cleanup. */
export function registerGuidedPathTestHooks(): void {
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
}

// The chosen situation's invitation — the grounding step renders it verbatim as
// the second prompt's whisper (mirrors the freeform path).
export const WHISPER = 'Whose debt is it, and why is it yours to pay?'
// Well over the 20-char backend floor the grounding field mirrors.
export const GROUNDING = 'A debt that was never mine came due on the worst possible night.'
export const SHORT = 'too short'

// The chosen situation's recap slice — LLM DATA the recap card renders verbatim
// (MYT-102): the grounding step keeps the opening scene in view while the player
// writes how they come to be in it.
export const SITUATION = {
  title: 'A debt come due',
  locationName: 'The Salt Ledger',
  prose: 'The counting-house wants paying.',
}

export const CAMPAIGN_ID = 'campaign-guided-1'

/** An in-memory draft store — the SessionDraftStore port the localStorage web impl
 *  satisfies. Shared across renders to model a back-to-chooser round-trip. */
export function makeDraftStore(): SessionDraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v)
    },
    remove: (k) => {
      map.delete(k)
    },
  }
}

export type Submit = (
  conceptText: string,
  situationGroundingText: string,
  guidedChoices: GuidedChoicesPayload,
) => Promise<void>

interface Overrides {
  startingLevel?: number
  submit?: Submit
  situation?: typeof SITUATION
  store?: SessionDraftStore
  onStepContext?: (stepContext: string | undefined) => void
}

export function renderGuided(overrides: Overrides = {}): {
  submit: Submit
  onSubmitted: () => void
  onSkipToFreeform: () => void
  onBack: () => void
  container: HTMLElement
} {
  const submit = overrides.submit ?? vi.fn().mockResolvedValue(undefined)
  const onSubmitted = vi.fn()
  const onSkipToFreeform = vi.fn()
  const onBack = vi.fn()
  const { container } = render(
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <GuidedPath
          startingLevel={overrides.startingLevel ?? 3}
          groundingWhisper={WHISPER}
          submit={submit}
          onSubmitted={onSubmitted}
          onSkipToFreeform={onSkipToFreeform}
          onBack={onBack}
          campaignId={CAMPAIGN_ID}
          {...(overrides.store !== undefined ? { store: overrides.store } : {})}
          {...(overrides.situation !== undefined ? { situation: overrides.situation } : {})}
          {...(overrides.onStepContext !== undefined ? { onStepContext: overrides.onStepContext } : {})}
        />
      </I18nextProvider>
    </ThemeProvider>,
  )
  return { submit, onSubmitted, onSkipToFreeform, onBack, container }
}

/** The current step's question — the GuidedBuilder's level-2 hero heading. */
export function question(): string {
  return screen.getByRole('heading', { level: 2 }).textContent
}

/** Click the option card carrying `data-option-id` (the durable selector — stable
 *  across copy changes, unlike the visible option name). */
export function pickOption(container: HTMLElement, id: string): void {
  const el = container.querySelector(`[data-option-id="${id}"]`)
  if (el === null) throw new Error(`no option card for id=${id}`)
  fireEvent.click(el)
}

/** Advance the guided builder — "Next" on the option grids, "Continue" on the
 *  single-option subclass consent step (myth-mttu7). */
export function next(): void {
  fireEvent.click(screen.getByRole('button', { name: /^(Next|Continue)$/ }))
}

/** Type into the single visible FreeformPrompt (notes/grounding) + press its
 *  submit control (Skip while the notes field is empty, Continue otherwise —
 *  the state-aware label of myth-z45sb; the row also carries a quiet Back). */
export function answerAndContinue(value: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } })
  fireEvent.click(
    within(screen.getByTestId('freeform-prompt')).getByRole('button', {
      name: /^(Skip|Continue)$/,
    }),
  )
}

/** The subclass consent statement for a class/subclass pair (myth-mttu7). */
export function subclassStatement(subclass: string, className: string): string {
  return i18n.t('characterCreate.guided.subclass.statement', { subclass, className })
}

// The typed-key augmentation rejects a runtime `string` key; the defaultValue
// overload accepts one (the keys all exist, so the fallback never surfaces).
export const q = (key: string): string => i18n.t(key, { defaultValue: key })
