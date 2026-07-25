import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { resetWorldgenLayouts, worldgenLayout } from '@mythrun/client-core/worldgen'
import type { GraphEdge, GraphNode } from '@mythrun/client-core/contract'
import { WorldGenGraph } from '../WorldGenGraph.tsx'

// Layout persistence across unmount/remount (ux-run3 myth-aftau). The generating
// view unmounts the graph whenever the player returns to the calm wait; before
// the layout cache every re-entry re-seeded the sim and every named place
// migrated hundreds of pixels (run-3 pixel evidence, frames 007 vs 009). With a
// `layoutCacheKey` the settled constellation is WORLD state: pin-on-settle
// writes each frozen placement into the session cache, and a remount pins the
// cached nodes straight back where the player saw them — only NEW entities
// settle freely. Exercised under reduced motion (the synchronous settle path)
// with a permissive fake 2D context, the same jsdom lever the main suite uses.

const node = (synthKey: string, kind: string, name: string): GraphNode => ({
  synthKey,
  kind,
  name,
  displayId: synthKey,
  state: 'live',
  lastEventIndex: 0,
})

const FIXTURE: GraphNode[] = [
  node('s1/reach', 'location', 'Ashfen Reach'),
  node('s2/maeris', 'npc', 'Maeris Vale'),
  node('s3/guild', 'faction', 'The Tallow Guild'),
]
const EDGES: GraphEdge[] = [
  { synthKey: 'e1', from: 's2/maeris', to: 's3/guild', relationship: 'leads', arrivalIndex: 0, sourceStage: 'weave' },
]

/** A permissive fake 2D context (mirrors the main suite): no-op methods, absorbed
 *  property writes, a plausible `measureText` — enough for the settle + pin path
 *  to run under jsdom. */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: (_t, prop) => (prop === 'measureText' ? (s: string) => ({ width: s.length * 7 }) : () => undefined),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D
}

afterEach(() => {
  vi.restoreAllMocks()
  resetWorldgenLayouts()
})

describe('WorldGenGraph — layout persistence (myth-aftau)', () => {
  it('persists the settled constellation and pins it back EXACTLY on remount; new arrivals still settle', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx())

    const first = render(
      <WorldGenGraph
        nodes={FIXTURE}
        edges={EDGES}
        onSelect={vi.fn()}
        reducedMotion
        layoutCacheKey="campaign-1"
      />,
    )
    const placements = worldgenLayout('campaign-1').placements
    // The settle froze the labeled nodes and wrote them through to the cache.
    expect(placements.size).toBeGreaterThanOrEqual(FIXTURE.length)
    const settled = new Map([...placements].map(([key, p]) => [key, { x: p.x, y: p.y }]))
    first.unmount()

    // Re-entry mid-generation: the same world, grown by one arrival.
    const grown = [...FIXTURE, node('s4/rows', 'location', 'Lantern Rows')]
    render(
      <WorldGenGraph
        nodes={grown}
        edges={EDGES}
        onSelect={vi.fn()}
        reducedMotion
        layoutCacheKey="campaign-1"
      />,
    )
    const after = worldgenLayout('campaign-1').placements
    // Every previously-placed node is EXACTLY where the player saw it — pinned
    // from the cache, never re-settled (a re-roll would move it with certainty:
    // seeding is random-jittered).
    for (const [key, pos] of settled) {
      const rehydrated = after.get(key)
      expect(rehydrated).toBeDefined()
      expect(rehydrated?.x).toBe(pos.x)
      expect(rehydrated?.y).toBe(pos.y)
    }
    // The new arrival settled freely around the pinned constellation and joined it.
    expect(after.has('s4/rows')).toBe(true)
  })

  it('keyless graphs (the reveal) never touch the cache', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx())
    render(<WorldGenGraph nodes={FIXTURE} edges={EDGES} onSelect={vi.fn()} reducedMotion />)
    // Nothing was created under any key this render could plausibly have used —
    // the cache only engages through an explicit `layoutCacheKey`.
    expect(worldgenLayout('campaign-1').placements.size).toBe(0)
  })
})
