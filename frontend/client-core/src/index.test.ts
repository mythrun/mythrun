import { describe, it, expect } from 'vitest'
import {
  createWsSessionClient,
  createSseStatusClient,
  configureStreamingFetch,
  useConnectionState,
} from '@mythrun/client-core'

// The package-root barrel must surface the realtime transport (MYT-85 T8) so the
// flows + the /dev/transport harness import it through `@mythrun/client-core`
// (R5) — never a deep `client-core/src/realtime/*` path. This pins that the public
// names resolve off the barrel: a rename/move that drops one fails here.
describe('@mythrun/client-core realtime barrel', () => {
  it('re-exports the realtime transport surface from the package root', () => {
    expect(createWsSessionClient).toBeTypeOf('function')
    expect(createSseStatusClient).toBeTypeOf('function')
    expect(configureStreamingFetch).toBeTypeOf('function')
    expect(useConnectionState).toBeTypeOf('function')
  })
})
