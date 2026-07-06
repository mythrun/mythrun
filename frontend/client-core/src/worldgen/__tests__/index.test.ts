import { describe, it, expect } from 'vitest'
import { createForceSim, createFogSim, deriveNodes, deriveEdges } from '../index.ts'

// The `@mythrun/client-core/worldgen` subpath barrel is the DOM-free-pure-data
// surface the UI library's WorldGenGraph (C4) imports WITHOUT pulling in the
// react-query/api/transport brain (that lives on the package-root barrel). Pin
// that the pure-data names resolve off this subpath: a rename/move that drops one
// fails here. (Nothing inside client-core imports this barrel — the root barrel
// reaches `useWorldGenStream` by its direct module path — so without this test the
// re-export lines ship ungated.)
describe('@mythrun/client-core/worldgen barrel', () => {
  it('re-exports the pure-data force-sim + reducers from the subpath root', () => {
    expect(createForceSim).toBeTypeOf('function')
    expect(createFogSim).toBeTypeOf('function')
    expect(deriveNodes).toBeTypeOf('function')
    expect(deriveEdges).toBeTypeOf('function')
  })

  it('createForceSim returns a working ForceSim instance', () => {
    const sim = createForceSim({ width: 4000, height: 4000 })
    sim.sync(
      [
        {
          synthKey: 's/0',
          kind: 'npc',
          name: 'A',
          displayId: 's/0',
          state: 'live',
          lastEventIndex: 0,
        },
      ],
      [],
    )
    sim.tick()
    expect(sim.positions().has('s/0')).toBe(true)
  })
})
