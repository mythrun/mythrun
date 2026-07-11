// The character-creation flow as a small pure state machine (MYT-90): states +
// transitions, NO network. The path-chooser forks into the freeform prompt or the
// guided builder; either submits into processing; processing reveals the sheet; the
// reveal confirms into the party staging roster or starts over back at the chooser.
//
// Platform-independent BRAIN (R1): the @mythrun/ui screens dispatch events and
// render the current state — the transition logic lives here, once.

/** The flow's screens. */
export type CreateState = 'chooser' | 'freeform' | 'guided' | 'processing' | 'reveal' | 'staging'

/** The events that drive transitions between screens. */
export type CreateEvent =
  | 'chooseFreeform'
  | 'chooseGuided'
  | 'skipToFreeform'
  | 'submit'
  | 'ready'
  | 'confirm'
  | 'startOver'
  | 'back'

// The transition table. An event absent from a state's map has no effect (the
// machine stays put) — see `createTransition`.
const TRANSITIONS: Record<CreateState, Partial<Record<CreateEvent, CreateState>>> = {
  chooser: { chooseFreeform: 'freeform', chooseGuided: 'guided' },
  freeform: { submit: 'processing', back: 'chooser' },
  guided: { submit: 'processing', back: 'chooser', skipToFreeform: 'freeform' },
  processing: { ready: 'reveal' },
  reveal: { confirm: 'staging', startOver: 'chooser' },
  staging: {},
}

/** Advance the flow: the next state for `event` from `state`, or `state` unchanged
 *  when the event does not apply there. */
export function createTransition(state: CreateState, event: CreateEvent): CreateState {
  return TRANSITIONS[state][event] ?? state
}

/** The character-creation flow machine: where it starts + how it transitions. */
export const createMachine = {
  initial: 'chooser',
  transition: createTransition,
} satisfies { initial: CreateState; transition: typeof createTransition }
