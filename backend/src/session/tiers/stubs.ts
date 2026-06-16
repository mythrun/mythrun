// backend/src/session/tiers/stubs.ts
//
// MYT-66 Task 4 — placeholder tier implementations.
//
// The real Fast Thinker (Anthropic-backed) landed in MYT-68. The remaining stub
// lets the turn loop (controller, queue, worker, pub/sub broadcast) be wired and
// smoked end-to-end without spending tokens. The stub is deterministic and
// side-effect-free: the FT emits one canned delta then returns one canned line.
// It reads the same public-by-construction `FtTurnContext` the real tier does
// (the parameter is underscore-named here only because this placeholder ignores
// it; fewer params still structurally satisfies the interface signature in
// types.ts).
//
// MYT-69: the in-turn SlowThinker seam was retired (the ST runs off the turn
// path in its own worker), so `StubSlowThinker` is gone. MYT-73: the on-path
// Scribe seam was retired too (the Scribe is a post-turn job), so `StubScribe`
// is gone — only the FT tier is left to stub.

import type { AssistantMessage, FastThinker, FtTurnContext, TurnEmitter } from './types.js'

/** Emits exactly one canned text delta, then returns one canned assistant line. */
export class StubFastThinker implements FastThinker {
  async render(_ctx: FtTurnContext, emit: TurnEmitter): Promise<AssistantMessage> {
    await emit.emitText('(the DM considers the scene…)')
    return { role: 'assistant', parts: [{ kind: 'text', text: '(the DM responds.)' }] }
  }
}
