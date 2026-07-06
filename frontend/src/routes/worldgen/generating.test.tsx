import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { StageProgress, WorldGenGraphProps } from '@mythrun/ui'
import { i18n } from '../../i18n/config.ts'
import { GeneratingView } from './generating.tsx'

// GeneratingView is the SOLE production consumer of <WorldGenGraph> during
// generation. C7 wires it to the GATED, fog-forward experience (§3.3/§3.4): the
// graph is `interactive={false}` (no entity list / no selection), the status card
// is fed the stream's `stages[]` + `costUsd` + a `[ph:]` stage-label map, and the
// fog FADE is keyed off STAGE progress (completed/total) so it reaches 0 (fog gone)
// at completion. WorldGenGraph is mocked to a props spy — its own rendering is
// covered by its unit test; here we assert the props are threaded through.

const { graphSpy } = vi.hoisted(() => ({ graphSpy: vi.fn() }))

vi.mock('@mythrun/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mythrun/ui')>()
  return {
    ...actual,
    WorldGenGraph: (props: WorldGenGraphProps): null => {
      graphSpy(props)
      return null
    },
  }
})

// jsdom has no matchMedia; install a query-aware one so this view's
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

const stage = (id: string, status: StageProgress['status']): StageProgress => ({
  stage: id,
  status,
  userId: null,
  costUsd: 0,
  startedAt: null,
  completedAt: null,
})

interface RenderOpts {
  readonly stages?: readonly StageProgress[]
  readonly costUsd?: number | null
}

function renderGenerating({ stages = [], costUsd = null }: RenderOpts = {}): void {
  render(
    <I18nextProvider i18n={i18n}>
      <GeneratingView nodes={[]} edges={[]} stages={stages} costUsd={costUsd} />
    </I18nextProvider>,
  )
}

/** The most recent props the spied WorldGenGraph was rendered with. */
function lastGraphProps(): WorldGenGraphProps {
  return graphSpy.mock.calls.at(-1)?.[0] as WorldGenGraphProps
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
})

describe('GeneratingView — reduced-motion wiring', () => {
  it('passes reducedMotion={true} to WorldGenGraph when the user prefers reduced motion', () => {
    mockMatchMedia(true)
    renderGenerating()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: true }))
  })

  it('passes reducedMotion={false} by default (no preference set)', () => {
    mockMatchMedia(false)
    renderGenerating()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: false }))
  })

  it('passes reducedMotion={false} when matchMedia is unavailable (SSR-safe default)', () => {
    if (typeof window !== 'undefined') Reflect.deleteProperty(window, 'matchMedia')
    renderGenerating()
    expect(graphSpy).toHaveBeenLastCalledWith(expect.objectContaining({ reducedMotion: false }))
  })
})

describe('GeneratingView — gated generation (§3.4)', () => {
  it('renders the graph GATED — interactive={false}, no C5 bridge', () => {
    renderGenerating()
    // The C5 `interactive` bridge is removed: generation is inert (no entity
    // list, no selection). The reveal keeps `interactive`; the gen view does not.
    expect(lastGraphProps().interactive).toBe(false)
  })
})

describe('GeneratingView — status card wiring (§3.3)', () => {
  it('feeds the status card the stream stages + cost', () => {
    const stages = [stage('concept_intake', 'running')]
    renderGenerating({ stages, costUsd: 1.25 })
    const { status } = lastGraphProps()
    expect(status?.stages).toEqual(stages)
    expect(status?.costUsd).toBe(1.25)
  })

  it('supplies an i18n stage-label map the card resolves (DS owns no copy)', () => {
    renderGenerating({ stages: [stage('concept_intake', 'running')] })
    const labels = lastGraphProps().status?.stageLabels
    // Real backend worldgen stage ids resolve to their i18n'd friendly labels.
    expect(labels?.concept_intake).toBe(i18n.t('worldGen.stage.concept_intake'))
    expect(labels?.embed_world).toBe(i18n.t('worldGen.stage.embed_world'))
  })

  it('supplies i18n framing labels (title/done/progress) for the card', () => {
    renderGenerating({ stages: [stage('concept_intake', 'running')] })
    const { status } = lastGraphProps()
    expect(status?.titleLabel).toBe(i18n.t('worldGen.statusTitle'))
    expect(status?.doneLabel).toBe(i18n.t('worldGen.statusDone'))
    expect(status?.progressLabel).toBe(i18n.t('worldGen.statusProgress'))
  })
})

describe('GeneratingView — fog fade keyed off STAGE progress (§3.2f / §3.8)', () => {
  it('fades from ~0 at the start (nothing completed → full fog)', () => {
    const stages = [
      stage('concept_intake', 'running'),
      stage('world_color', 'pending'),
      stage('vocabulary_intake', 'pending'),
    ]
    renderGenerating({ stages })
    const props = lastGraphProps()
    // shown/total = 0/3 → remaining 1 → fog holds full density (fade fraction 0).
    expect(props.shownEntities).toBe(0)
    expect(props.totalEntities).toBe(3)
  })

  it('derives shown/total from completed vs total stages mid-gen', () => {
    const stages = [
      stage('concept_intake', 'completed'),
      stage('world_color', 'completed'),
      stage('vocabulary_intake', 'running'),
      stage('world_and_factions', 'pending'),
      stage('locations_and_npcs', 'pending'),
    ]
    renderGenerating({ stages })
    const props = lastGraphProps()
    expect(props.shownEntities).toBe(2)
    expect(props.totalEntities).toBe(5)
  })

  it('reaches FULL fade at completion — fog gone at the reveal moment (invariant)', () => {
    const stages = [
      stage('concept_intake', 'completed'),
      stage('world_color', 'completed'),
      stage('coherence_pass', 'completed'),
    ]
    renderGenerating({ stages })
    const props = lastGraphProps()
    // shown === total → remaining 0 → effectiveDensity 0 → fog fully gone.
    expect(props.shownEntities).toBe(3)
    expect(props.totalEntities).toBe(3)
    expect(props.shownEntities).toBe(props.totalEntities)
  })

  it('holds base density before the first snapshot frame (no stages → total 0)', () => {
    renderGenerating({ stages: [] })
    const props = lastGraphProps()
    // total 0 disables the fade in WorldGenFogField (base density fog).
    expect(props.shownEntities).toBe(0)
    expect(props.totalEntities).toBe(0)
  })
})
