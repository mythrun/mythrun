import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import {
  ApiClientProvider,
  HttpError,
  type ApiContext,
  type CharacterFull,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { CharacterRevealSurface } from './character-reveal.tsx'

// The CHARACTER-REVEAL SURFACE (MYT-90 D6) — the "Meet your character" screen the D8
// routing table mounts once the viewer's concept is `completed` & unconfirmed. It
// fetches the character via the injected `getCharacter` seam, adapts the raw shape
// into the reveal's view-model, renders the DS <CharacterSheetReveal>, and wires the
// three actions: "This is me" → confirmCharacter → onConfirmed (D8 re-routes to
// staging); "Start over" → resetCharacterConcept → onReset (D8 re-routes to create);
// "See full sheet" → a LOCAL expand (no network). These tests inject the three
// endpoint seams (defaults are the real endpoints) and assert each path. All three
// providers wrap the surface (ThemeProvider reads localStorage on mount → the
// in-memory shim; i18n serves the real catalog; ApiClientProvider carries the ctx).

// ENVIRONMENT shim (Node vs jsdom): @mythrun/ui's <ThemeProvider> reads `localStorage`
// on mount; the platform builtin can shadow jsdom's real Storage. Install a functional
// in-memory one (mirrors level-pick.test.tsx).
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

const testCtx: ApiContext = {
  baseUrl: 'http://api.test',
  getAuthHeaders: () => Promise.resolve({}),
}

const CAMPAIGN_ID = 'c1'
const CHAR_ID = 'char-1'

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

const RAW: CharacterFull = {
  character: {
    id: CHAR_ID,
    user_id: 'u1',
    entity_id: null,
    name: 'Kessa Vurm',
    level: 3,
    class: 'Fighter',
    species: 'Human',
    background: 'Toll-clerk of Greenward',
    str: 16,
    dex: 13,
    con: 15,
    int: 12,
    wis: 11,
    cha: 9,
    hit_points: 28,
    max_hit_points: 28,
    armor_class: 16,
    proficiency_bonus: 2,
    gold: 9,
    hit_die: 10,
    hit_dice_remaining: 3,
    spellcasting_progression: 'none',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  skills: [{ skill_name: 'Athletics', proficiency_level: 'proficient' }],
  features: [
    { feature_name: 'Second Wind', feature_source: 'Fighter', description: 'Catch her breath.' },
  ],
  equipment: [{ item_name: 'Longsword', quantity: 1, equipped: true }],
  spells: [],
}

interface Seams {
  getCharacter?: (ctx: ApiContext, campaignId: string, charId: string) => Promise<CharacterFull>
  confirmCharacter?: (ctx: ApiContext, campaignId: string) => Promise<void>
  resetCharacterConcept?: (ctx: ApiContext, campaignId: string) => Promise<void>
  onConfirmed?: () => void
  onReset?: () => void
}

function renderSurface(seams: Seams = {}): Required<Seams> {
  const resolved: Required<Seams> = {
    getCharacter: seams.getCharacter ?? vi.fn().mockResolvedValue(RAW),
    confirmCharacter: seams.confirmCharacter ?? vi.fn().mockResolvedValue(undefined),
    resetCharacterConcept: seams.resetCharacterConcept ?? vi.fn().mockResolvedValue(undefined),
    onConfirmed: seams.onConfirmed ?? vi.fn(),
    onReset: seams.onReset ?? vi.fn(),
  }
  render(
    <ThemeProvider>
      <ApiClientProvider value={testCtx}>
        <I18nextProvider i18n={i18n}>
          <CharacterRevealSurface
            campaignId={CAMPAIGN_ID}
            charId={CHAR_ID}
            onConfirmed={resolved.onConfirmed}
            onReset={resolved.onReset}
            getCharacter={resolved.getCharacter}
            confirmCharacter={resolved.confirmCharacter}
            resetCharacterConcept={resolved.resetCharacterConcept}
          />
        </I18nextProvider>
      </ApiClientProvider>
    </ThemeProvider>,
  )
  return resolved
}

describe('CharacterRevealSurface — fetch + adapt + render', () => {
  it('fetches the character and renders the reveal (name + adapted identity)', async () => {
    const getCharacter = vi.fn().mockResolvedValue(RAW)
    renderSurface({ getCharacter })
    await screen.findByTestId('character-sheet-reveal')
    expect(getCharacter).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID, CHAR_ID)
    expect(screen.getByText('Kessa Vurm')).toBeDefined()
    expect(screen.getByText('Level 3 · Human Fighter · Toll-clerk of Greenward')).toBeDefined()
  })

  it('holds on a calm loading line while the fetch is in flight', () => {
    const pending = new Promise<CharacterFull>(() => {
      /* never resolves */
    })
    renderSurface({ getCharacter: vi.fn(() => pending) })
    expect(screen.getByTestId('character-reveal-loading')).toBeDefined()
    expect(screen.queryByTestId('character-sheet-reveal')).toBeNull()
  })

  it('surfaces a retryable error and re-fetches on retry', async () => {
    const getCharacter = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(RAW)
    renderSurface({ getCharacter })
    await screen.findByTestId('character-reveal-error')
    fireEvent.click(screen.getByText(i18n.t('characterCreate.reveal.retry')))
    await screen.findByTestId('character-sheet-reveal')
    expect(getCharacter).toHaveBeenCalledTimes(2)
  })
})

describe('CharacterRevealSurface — actions', () => {
  it('"This is me" confirms then calls onConfirmed', async () => {
    const confirmCharacter = vi.fn().mockResolvedValue(undefined)
    const onConfirmed = vi.fn()
    renderSurface({ confirmCharacter, onConfirmed })
    await screen.findByTestId('character-sheet-reveal')
    fireEvent.click(screen.getByRole('button', { name: /This is me/ }))
    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledTimes(1)
    })
    expect(confirmCharacter).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID)
  })

  it('"Start over" resets then calls onReset', async () => {
    const resetCharacterConcept = vi.fn().mockResolvedValue(undefined)
    const onReset = vi.fn()
    renderSurface({ resetCharacterConcept, onReset })
    await screen.findByTestId('character-sheet-reveal')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('characterCreate.reveal.startOver') }))
    await waitFor(() => {
      expect(onReset).toHaveBeenCalledTimes(1)
    })
    expect(resetCharacterConcept).toHaveBeenCalledWith(expect.anything(), CAMPAIGN_ID)
  })

  it('"See full sheet" expands the mechanical sheet with NO network', async () => {
    const getCharacter = vi.fn().mockResolvedValue(RAW)
    const confirmCharacter = vi.fn()
    const resetCharacterConcept = vi.fn()
    renderSurface({ getCharacter, confirmCharacter, resetCharacterConcept })
    await screen.findByTestId('character-sheet-reveal')
    expect(screen.queryByTestId('character-sheet-reveal-full')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'See full sheet' }))
    await screen.findByTestId('character-sheet-reveal-full')
    // No refetch, and neither mutation fired — a pure client reveal.
    expect(getCharacter).toHaveBeenCalledTimes(1)
    expect(confirmCharacter).not.toHaveBeenCalled()
    expect(resetCharacterConcept).not.toHaveBeenCalled()
  })

  it('keeps the reveal up with a calm note when confirm fails (no onConfirmed)', async () => {
    const confirmCharacter = vi.fn().mockRejectedValue(new HttpError(409, 'Conflict', 'not_confirmable'))
    const onConfirmed = vi.fn()
    renderSurface({ confirmCharacter, onConfirmed })
    await screen.findByTestId('character-sheet-reveal')
    fireEvent.click(screen.getByRole('button', { name: /This is me/ }))
    await screen.findByTestId('character-reveal-action-error')
    expect(onConfirmed).not.toHaveBeenCalled()
    expect(screen.getByTestId('character-sheet-reveal')).toBeDefined()
  })

  it('keeps the reveal up with a calm note when reset fails (no onReset)', async () => {
    const resetCharacterConcept = vi.fn().mockRejectedValue(new HttpError(409, 'Conflict', 'not_resettable'))
    const onReset = vi.fn()
    renderSurface({ resetCharacterConcept, onReset })
    await screen.findByTestId('character-sheet-reveal')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('characterCreate.reveal.startOver') }))
    await screen.findByTestId('character-reveal-action-error')
    expect(onReset).not.toHaveBeenCalled()
  })
})
