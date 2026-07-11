import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { LoadingBeat } from '@mythrun/client-core/contract'
import { useCharacterCreationStream } from '@mythrun/client-core/character'
import { i18n } from '../../i18n/config.ts'
import { CharacterLoadingSurface } from './character-loading.tsx'

// CharacterLoadingSurface (MYT-90 D5) — the processing-state screen D8 mounts
// while the viewer's character concept is being generated. It composes the DS
// <CharacterLoadingBeat> over the client-core useCharacterCreationStream, and
// calls `onDone` the instant the viewer's own completion arrives so D8 re-routes
// to the reveal. The stream hook is MOCKED off its barrel (its own folding is
// covered by use-character-creation-stream.test.ts) — here we assert the surface
// composition, the reduced-motion wiring, and the one-shot `done → onDone` swap.

vi.mock('@mythrun/client-core/character', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/client-core/character')>()
  return { ...actual, useCharacterCreationStream: vi.fn() }
})
const mockStream = vi.mocked(useCharacterCreationStream)

// jsdom has no matchMedia; install a query-aware one so the surface's
// prefers-reduced-motion read resolves to the value under test.
function mockMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
}

const CID = 'c1'
const UID = 'u1'

const MID_BEATS: LoadingBeat[] = [
  { id: 'name', label: 'a name surfaces', state: 'done' },
  { id: 'class', label: 'a class takes shape', state: 'done' },
  { id: 'scores', label: 'ability scores settle', state: 'active' },
  { id: 'kit', label: 'equipment is gathered', state: 'pending' },
]
const DONE_BEATS: LoadingBeat[] = MID_BEATS.map((b) => ({ ...b, state: 'done' }))

interface RenderOpts {
  readonly beats?: LoadingBeat[]
  readonly done?: boolean
  readonly onDone?: () => void
}

function surface(onDone: () => void): React.JSX.Element {
  return (
    <I18nextProvider i18n={i18n}>
      <CharacterLoadingSurface campaignId={CID} userId={UID} onDone={onDone} />
    </I18nextProvider>
  )
}

function renderSurface({ beats = MID_BEATS, done = false, onDone = vi.fn() }: RenderOpts = {}) {
  mockStream.mockReturnValue({ beats, done })
  return render(surface(onDone))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

describe('CharacterLoadingSurface', () => {
  it('drives the stream with the campaign + viewer ids', () => {
    renderSurface()
    // deps is unset here → the surface forwards `undefined` (the hook then
    // defaults to the real SSE client). D8 mounts it exactly this way.
    expect(mockStream).toHaveBeenCalledWith(CID, UID, undefined)
  })

  it("renders the loading beat from the hook's beats", () => {
    renderSurface({ beats: MID_BEATS })
    expect(screen.getByTestId('character-loading-beat')).toBeDefined()
    const rows = screen.getAllByTestId('character-loading-beat-row')
    expect(rows.map((r) => r.getAttribute('data-beat-id'))).toEqual(['name', 'class', 'scores', 'kit'])
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'active',
      'pending',
    ])
  })

  it('renders the i18n screen title as a heading', () => {
    renderSurface()
    expect(
      screen.getByRole('heading', { name: i18n.t('characterCreate.loading.title') }),
    ).toBeDefined()
  })

  it('does not call onDone while the character is still processing (done false)', () => {
    const onDone = vi.fn()
    renderSurface({ done: false, onDone })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('calls onDone once when the stream already reports done', () => {
    const onDone = vi.fn()
    renderSurface({ done: true, onDone })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('calls onDone exactly once when done flips true, and never again on later re-renders', () => {
    const onDone = vi.fn()
    mockStream.mockReturnValue({ beats: MID_BEATS, done: false })
    const { rerender } = render(surface(onDone))
    expect(onDone).not.toHaveBeenCalled()

    // The viewer's completion arrives — the swap fires once.
    mockStream.mockReturnValue({ beats: DONE_BEATS, done: true })
    rerender(surface(onDone))
    expect(onDone).toHaveBeenCalledTimes(1)

    // Still done on a further re-render — the latch holds; it must not fire again.
    rerender(surface(onDone))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('passes reducedMotion=true to the beat when the user prefers reduced motion', () => {
    mockMatchMedia(true)
    renderSurface()
    expect(screen.getByTestId('character-loading-beat').getAttribute('data-reduced-motion')).toBe(
      'true',
    )
  })

  it('passes reducedMotion=false by default (no preference set)', () => {
    mockMatchMedia(false)
    renderSurface()
    expect(screen.getByTestId('character-loading-beat').getAttribute('data-reduced-motion')).toBe(
      'false',
    )
  })
})
