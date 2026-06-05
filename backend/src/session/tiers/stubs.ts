// backend/src/session/tiers/stubs.ts
//
// MYT-66 Task 4 — placeholder tier implementations.
//
// The real Fast/Slow Thinker + Scribe (Anthropic-backed) land in MYT-68/69.
// Until then the turn loop needs SOMETHING implementing each seam interface so
// the controller, queue, worker, and pub/sub broadcast can be wired and smoked
// end-to-end without spending tokens. These stubs are deterministic and
// side-effect-free: the ST never intervenes, the FT emits one canned delta then
// returns one canned line, the Scribe is a no-op. They read the same
// public-by-construction `FtTurnContext` the real tiers will (the parameter is
// omitted here only because these placeholders ignore it; fewer params still
// structurally satisfies the interface signatures in types.ts).

import type {
  AssistantMessage,
  FastThinker,
  FtTurnContext,
  Scribe,
  ScribeResult,
  SlowThinker,
  StEvaluation,
  TurnEmit,
} from './types.js'

/** Never intervenes — the turn always flows straight to the Fast Thinker. */
export class StubSlowThinker implements SlowThinker {
  evaluate(_ctx: FtTurnContext): Promise<StEvaluation> {
    void _ctx
    return Promise.resolve({ intervene: false })
  }
}

/** Emits exactly one canned text delta, then returns one canned assistant line. */
export class StubFastThinker implements FastThinker {
  async render(_ctx: FtTurnContext, emit: TurnEmit): Promise<AssistantMessage> {
    await emit('(the DM considers the scene…)')
    return { role: 'assistant', content: '(the DM responds.)' }
  }
}

/** No-op: produces no working-set deltas for the controller to flush (H9). */
export class StubScribe implements Scribe {
  extract(_ctx: FtTurnContext): Promise<ScribeResult> {
    void _ctx
    return Promise.resolve({ workingSetDeltas: [] })
  }
}
