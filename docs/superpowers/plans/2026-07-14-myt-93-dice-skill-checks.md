# MYT-93 Dice & Skill Checks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1 is a VERIFY-FIRST bead — do it before writing any code (spec §5 verify-first bead 4). TDD is mandatory: a failing test that defines "done" precedes every implementation step.

**Goal:** Turn the terse mono `skill_check` / `dice_roll` system lines MYT-92 renders into the dice moment (spec §5). A `skill_check` frame — already **fully server-resolved in ONE frame** (roll, roll2, rollType, modifier, total, dc, outcomeTier, constraint) — renders in-stream as a `RollCard`: skill + context + posture, a **Roll** button that spins a flat 2D outlined d20 (`DieSpin`, stepped rotation), the server's result stamps in, mod/total/DC/outcome-tier settle under it, and **Continue** releases the buffered post-check outcome prose. `dice_roll` renders the same card minus the skill/DC dressing. All the reveal work is **client-side theater over an already-received number** — there is **NO client→server roll interaction** (the `roll_complete` frame is deliberately absent from the client frame types — contract §5) and **NO backend work**. Every reasoning primitive (reveal state, the prose gate) lands in `@mythrun/client-core`; the two new components land in `@mythrun/ui`; MYT-92's committed `MessageStream` dispatch + play-route shell are EXTENDED (rendering only).

**Architecture:** MYT-92 already models `skill_check` / `dice_roll` as first-class transcript items carrying the whole frame (the wave-2 shared contract, spec §7) — MYT-93 extends the **RENDERING** of those items, never the reducer shape. The reveal is **presentation-side**: a small pure `session/roll-reveal.ts` reducer in client-core tracks the two committed player interactions (rolled / continued) by item key; two pure selectors derive each card's phase and the set of turns whose outcome prose is still gated. `useSession` is **UNTOUCHED** — the "buffer" that holds the post-check prose is a **render gate over the transcript the hook already produces**, not a hold-back inside the hook (grounded in the committed `use-session.ts`: `text_delta` folds into a `dm` item keyed on `turnId` as normal; the gate simply declines to render that `dm` item until the turn's card is continued). This is correct because the FT prompt instructs **"Call the tool first. Write prose based on the result"** (`ft-system.txt:37`), so the dominant live frame order is `skill_check(T)` → `text_delta(T)…` → `turn_end(T)`, which the committed reducer lands as `[skill_check(T) card, dm(T) prose]` — card first, prose after, cleanly gateable. Replayed cards (a reconnect row carries a `seq`) render already-revealed — no theater on backlog/history.

**Tech Stack:** React + Vite + TS strict; `@mythrun/{contract,client-core,ui}` + web; Vitest + RTL + jest-axe; the committed MYT-92 `session/` view-model; i18n `[ph:]` keys. No new dependency, no migration, no `pipelineRoute`, no dev-tool manifest.

## Global Constraints

- **Enforced ignorance / ZFC / no new wire surface:** render only transport-delivered frames. Add NO client frame type (the Roll button sends NOTHING — `roll_complete` stays excluded), NO server frame, NO read surface. The reveal is deterministic UI mechanism (a sanctioned ZFC exception — no LLM cognition, no pattern-matching on prose). **Do NOT render the `constraint` field on the card** — it is the outcome seed the DM's gated prose is written from; showing it would pre-empt the buffered narrative.
- **Named exports only; strict TS (no `any`, no assertions unless unavoidable); functions < 50 lines; modules < 400 lines.**
- **Design-system-first (R5):** no ad-hoc UI. `DieSpin` + `RollCard` live in `@mythrun/ui`, each with a Storybook story + tests, import props from `@mythrun/client-core/contract`, are square-register (no circles, no status dots/chips — outcome tiers are **typographic weight, never colour chips**), and work desktop AND ~375px. **Two typefaces only:** all mechanical readouts (die numerals, mod/total/DC/tier) are `--font-ui` (IBM Plex Mono, `font-ui`); no third face.
- **R1 portability seam:** `@mythrun/ui` components read PROP TYPES from `@mythrun/client-core/contract` and take neutral callbacks. The reveal PHASE + gate are computed by client-core selectors in the web route and passed to `MessageStream` as **plain derived data** (`RollRevealView` — a `Record` + a `Set`), so no UI component imports a client-core runtime reducer/selector.
- **Motion / reduced-motion:** `DieSpin`'s rotation is a **STEPPED 2D rotation — 8 steps/revolution, ~1s, pixel-honest, never smoothly interpolated** (the motion analog of the brand's stepped Bayer dither; this deliberately overrides UX §13's "smooth" per the brand-overrides-UX rule). `prefers-reduced-motion` → **no spin, instant land**, and Continue still releases the prose on the same explicit press. Motion is never the only signal (a polite live region announces the result).
- **i18n:** every user-facing label (`Roll`, `Continue`, the outcome-tier words, DC prefix, the die's SR numeral label) is a key with a `[ph:]` placeholder value; `common.json` + `descriptions.ts` in lockstep (the `resources.test.ts` drift test asserts identical key sets). MYT-100 is the one copy pass — do NOT write real copy. Frame numbers + `skill` / `context` are DATA, never keys.
- **Accessibility:** the 100×4 bar (100% statements/branches/functions/lines on new source) + the CI storybook browser sweep (a11y contrast + overflow gates) both gate. The die is `aria-hidden` decoration; the result + tier announce via a polite live region.
- **§7 shared wave-2 surfaces (parallel-handler-contract):** MYT-93 EDITS `frontend/ui/src/components/MessageStream/MessageStream.tsx` (+ its committed tests/stories), `MessageStreamProps` (append-only), `frontend/src/routes/play/session-shell.tsx`, the `ui`/`contract` barrels, and i18n `common.json`/`descriptions.ts` (append-only). MYT-94 also extends `MessageStream` (entity highlighting inside `DmMessage`) and the play-route sidebar — the controller SERIALIZES: **93 lands the in-stream card rendering first**, 94 rebases. 93 touches NO other play-route file. Because 93 branches from main AFTER 92 merges (spec §7), these files are already present — 93 extends, never restructures.
- Test conventions: co-located `__tests__/x.test.ts(x)` (client-core) / `X.test.tsx` + `X.stories.tsx` (ui); Vitest + RTL; mirror `backend/src/__tests__/CONVENTIONS.md` (single isolation, no shared mutable state). Frequent commits (Conventional Commits, one per task).

---

## Phase 0 — Verify-first (spec §5, verify-first bead 4)

### Task 1: Drive a real skill_check turn and record the frame sequence (no code)

**Files:** Create `tmp/sdd/myt93-verify-notes.md` (plan-adjacent scratch; NOT committed).

**Interfaces:**
- Consumes (observe, do not build): a live dev-stack session over the shipped WS transport; the `skill_check` frame (`frontend/contract/src/events/session-events.ts:178-193`); the persisted `session_messages` rows (`psql`).
- Produces: the verbatim observed frame ORDER + the replay shape the reveal + card tasks build against.

The whole design leans on one empirical fact: **within a skill-check turn, does the `skill_check` frame arrive BEFORE the outcome `text_delta` (the clean case), or can prose precede the tool call?** `ft-system.txt:37` says "Call the tool first," and the consume loop emits in model-output order (`fast-thinker.ts:747-783`) — so the DOMINANT order should be tool-first. Confirm it on the wire before building; do NOT trust this plan's transcription.

- [ ] **Step 1 — bring up the dev stack** (`pnpm dev`; backend on `:3030`). Start a real session on an owner-completed, prep-ready campaign (drive the MYT-92 play route in the browser, or reuse its E2E harness). Record the campaignId + sessionId.
- [ ] **Step 2 — provoke a skill check.** Send a player message that forces `roll_skill_check` (a deception/persuasion/perception/stealth attempt — e.g. `"I try to pick the lock on the strongbox"` or `"I lie and tell the guard I'm the baron's courier"`; the prompt's frequency rule + social-check rules make one fire). Capture the LIVE WS frames in order (browser devtools WS inspector, or a small `ws` node client that does the ticket handshake). Record the EXACT sequence around the check: `dm_thinking` → `skill_check{turnId,…}` → `text_delta{turnId}×N` → `turn_end{turnId}`. **Confirm:** does any `text_delta` for that turnId arrive BEFORE the `skill_check`? Note the live `skill_check` frame has **no `seq`**.
- [ ] **Step 3 — record the full skill_check frame** verbatim: `roll`, `roll2` (null on a normal roll), `rollType`, `modifier`, `total`, `dc`, `outcomeTier`, `constraint`, `characterName`, `skill`, `context`. Note that `total = usedNaturalRoll + modifier` (so the die-centre natural roll the card stamps = `total − modifier`), and on advantage/disadvantage BOTH `roll` and `roll2` are present.
- [ ] **Step 4 — replay shape.** Reconnect (kill/re-open the socket, or `__simulateDrop` in the harness) and capture the `session_reconnect` batch: the `skill_check` replays **carrying a `seq`** (the persisted row) and the outcome prose replays consolidated as `dm_message{seq,turnId,text}`. Also `psql`: `SELECT seq, turn_id, message_type, content FROM session_messages WHERE ... ORDER BY seq` — record the `skill_check` row's `content` JSON (`{toolCallId, input, output}`; the `output` carries the snake_case roll fields) — this is what the E2E psql-verifies the card's numbers against.
- [ ] **Step 5 — multi-check probe (edge).** Send `"we all search the room"` with ≥2 characters and record whether the turn emits MULTIPLE `skill_check` frames sharing one `turnId` (per `ft-system.txt:33`, "call `roll_skill_check` once per character").
- [ ] **Step 6 — write `tmp/sdd/myt93-verify-notes.md`** with the verbatim frames/order/replay JSON. **If Step 2 shows outcome prose can precede the `skill_check` frame, or the multi-check turnId sharing differs from the plan's assumption, surface it to the controller before proceeding** (it bears on Spec Ambiguity #2 / #4 below — do not silently re-map).

---

## Phase A — client-core brain (`session/roll-reveal.ts` — new)

### Task 2: Roll-reveal reducer + phase/gate selectors + `useRollReveal`

**Files:**
- Create: `frontend/client-core/src/session/roll-reveal.ts`
- Modify: `frontend/client-core/src/index.ts` (barrel — append-only)
- Test: `frontend/client-core/src/session/__tests__/roll-reveal.test.tsx`

**Interfaces:**
- Consumes: `TranscriptItem` (`./transcript-types.ts`).
- Produces:
  - `RollPhase = 'idle' | 'revealed' | 'released'`.
  - `RollRevealState` + `emptyRollReveal` + `rollRevealReducer` (actions `roll` / `continue`, keyed by item `key`).
  - `cardPhase(item, state): RollPhase` — DERIVES a card's phase; a replayed card (`frame.seq !== undefined`) is always `released` (history, no theater).
  - `buildRevealView(items, state): RollRevealView` — the plain derived data `MessageStream` renders against: `{ phaseByKey: Record<string, RollPhase>; gatedTurnIds: ReadonlySet<string> }`. Only `skill_check` cards gate prose (dice_roll is the flavor variant — spec §5).
  - `useRollReveal(): { state; roll(key); advance(key) }` — the `useReducer` wrapper (`advance` = "continue"; avoids the JS keyword).

**Design (pin in the module header):** presentation ONLY — the roll is already server-resolved, so this layer only delays the DISPLAY of an already-received number and gates the post-check prose behind an explicit Continue. It NEVER sends anything to the server. `useSession` is untouched. The card's spin is a LOCAL `DieSpin` transition (Task 4); the reducer tracks only the two COMMITTED interactions.

- [ ] **Step 1 — failing tests** (pure reducer + selectors, one React test for the hook): (a) `rollRevealReducer` `roll` adds the key to `rolled` (idempotent — a second `roll` is a no-op returning the same reference); (b) `continue` adds to `continued` AND ensures `rolled` (a continue without a prior roll still lands `released`); (c) `cardPhase` on a LIVE card (`frame.seq === undefined`): `idle` with no interaction, `revealed` after `roll`, `released` after `continue`; (d) `cardPhase` on a REPLAYED card (`frame.seq` set) is `released` regardless of state; (e) `buildRevealView` maps every skill_check/dice_roll key to its phase AND gates the turnId of an un-`released` SKILL_CHECK (a dice_roll never gates; a released skill_check does not gate); (f) a turn with TWO skill_check cards (same turnId) stays gated until BOTH are `released`; (g) `useRollReveal` exposes `roll`/`advance` that drive the state. Run → FAIL.
- [ ] **Step 2 — implement:**
```ts
// frontend/client-core/src/session/roll-reveal.ts
import { useCallback, useReducer } from 'react'
import type { TranscriptItem } from './transcript-types.ts'

// Reveal state for the dice/skill-check theater (MYT-93, spec §5). PRESENTATION
// ONLY — the roll is already server-resolved (the skill_check/dice_roll frame
// carries the WHOLE result); this layer just delays the DISPLAY of an
// already-received number and gates the post-check outcome prose behind an
// explicit "Continue". It NEVER sends anything to the server: there is no
// client→server roll frame (roll_complete is deliberately excluded — contract
// §5). useSession is UNTOUCHED — the "buffer" is a render gate over the
// transcript the hook already produces, not a hold-back in the hook.
//
// A card's phase is DERIVED, never stored per frame:
//   • a REPLAYED card (frame carries a `seq` — a persisted reconnect row) is
//     HISTORY → renders already-`released` (no theater on backlog/reconnect).
//   • a LIVE card (no seq): `idle` (Roll) → `revealed` (numbers + Continue) →
//     `released` (prose gate opens). The spin itself is a LOCAL DieSpin
//     transition; the reducer tracks only the two COMMITTED interactions by key.

/** A skill_check or dice_roll transcript item — the two card kinds. */
export type CardItem = Extract<TranscriptItem, { kind: 'skill_check' } | { kind: 'dice_roll' }>

export type RollPhase = 'idle' | 'revealed' | 'released'

export interface RollRevealState {
  /** Item keys the player has rolled (spin committed). */
  readonly rolled: ReadonlySet<string>
  /** Item keys the player has continued (prose released). */
  readonly continued: ReadonlySet<string>
}

export const emptyRollReveal: RollRevealState = {
  rolled: new Set<string>(),
  continued: new Set<string>(),
}

export type RollRevealAction = { type: 'roll'; key: string } | { type: 'continue'; key: string }

export function rollRevealReducer(state: RollRevealState, action: RollRevealAction): RollRevealState {
  switch (action.type) {
    case 'roll':
      if (state.rolled.has(action.key)) return state
      return { ...state, rolled: new Set(state.rolled).add(action.key) }
    case 'continue': {
      if (state.continued.has(action.key)) return state
      // Continue implies rolled (a reduced-motion instant-land, or a defensive
      // direct-continue, still lands both).
      const rolled = state.rolled.has(action.key) ? state.rolled : new Set(state.rolled).add(action.key)
      return { rolled, continued: new Set(state.continued).add(action.key) }
    }
  }
}

/** Derive a card's phase. A replayed row (persisted `seq`) is history → released. */
export function cardPhase(item: CardItem, state: RollRevealState): RollPhase {
  if (item.frame.seq !== undefined) return 'released'
  if (state.continued.has(item.key)) return 'released'
  if (state.rolled.has(item.key)) return 'revealed'
  return 'idle'
}

/** The plain derived data MessageStream renders against (R1: no UI-side runtime
 *  import of this module — the route computes this and passes it as a prop). */
export interface RollRevealView {
  readonly phaseByKey: Readonly<Record<string, RollPhase>>
  /** turnIds whose outcome prose is still gated (any un-released SKILL_CHECK). */
  readonly gatedTurnIds: ReadonlySet<string>
}

export function buildRevealView(items: readonly TranscriptItem[], state: RollRevealState): RollRevealView {
  const phaseByKey: Record<string, RollPhase> = {}
  const gated = new Set<string>()
  for (const it of items) {
    if (it.kind !== 'skill_check' && it.kind !== 'dice_roll') continue
    const phase = cardPhase(it, state)
    phaseByKey[it.key] = phase
    // dice_roll is the flavor variant — it never gates prose (spec §5).
    if (it.kind === 'skill_check' && phase !== 'released') gated.add(it.turnId)
  }
  return { phaseByKey, gatedTurnIds: gated }
}

export interface RollReveal {
  readonly state: RollRevealState
  roll(key: string): void
  advance(key: string): void
}

export function useRollReveal(): RollReveal {
  const [state, dispatch] = useReducer(rollRevealReducer, emptyRollReveal)
  const roll = useCallback((key: string) => { dispatch({ type: 'roll', key }) }, [])
  const advance = useCallback((key: string) => { dispatch({ type: 'continue', key }) }, [])
  return { state, roll, advance }
}
```
- [ ] **Step 3 — barrel:** append `useRollReveal`, `buildRevealView` (+ the `RollPhase` / `RollRevealState` / `RollRevealView` / `CardItem` types) to `client-core/src/index.ts`. Run the reveal test (100×4 scoped) + `pnpm --filter @mythrun/client-core typecheck` → PASS.
- [ ] **Step 4 — commit** `feat(MYT-93): roll-reveal reducer + phase/gate selectors + useRollReveal`.

---

## Phase B — contract prop-contracts

### Task 3: Session contract additions (RollCard / DieSpin props + MessageStream extension)

**Files:**
- Create: `frontend/client-core/src/contract/session/roll-card.ts`, `frontend/client-core/src/contract/session/die-spin.ts`
- Modify: `frontend/client-core/src/contract/session/message-stream-props.ts` (append-only), `frontend/client-core/src/contract/session/index.ts` (re-export — append-only)
- Test: type-only (tsc) + the existing `contract/session/__tests__` barrel assertion (extend to cover the new type-only re-exports).

**Interfaces (DOM-free prop types, R1; neutral callbacks only):**
- `RollPhase`, `RollRevealView`, `CardItem` re-exported from `../../session/roll-reveal.ts` (TYPE only — the module's runtime stays out of the barrel, mirroring how `TranscriptItem` is re-exported).
- `RollCardLabels` — the resolved `[ph:]` bundle the route passes (so `MessageStream` can thread it to each card without a translation import):
```ts
export interface RollCardLabels {
  /** The Roll button (idle phase). */ readonly roll: string
  /** The Continue button (revealed skill_check). */ readonly continue: string
  /** outcomeTier → its word (rendered as typographic WEIGHT, never a colour chip). */
  readonly tier: Readonly<Record<'fail' | 'success' | 'great_success', string>>
  /** The "DC" readout prefix. */ readonly dc: string
  /** advantage / disadvantage posture tags (normal shows none). */
  readonly advantage: string
  readonly disadvantage: string
  /** SR label naming the die's stamped result (motion is never the only signal). */
  readonly dieResult: string
}
```
- `RollCardProps` — `{ item: CardItem; phase: RollPhase; reducedMotion: boolean; labels: RollCardLabels; onRoll: () => void; onContinue: () => void }`.
- `DieSpinProps` — `{ spinning: boolean; result: number | null; reducedMotion: boolean; onSpinComplete: () => void; resultLabel?: string }`.
- `MessageStreamProps` (append) — add `rollReveal: RollRevealView`, `rollLabels: RollCardLabels`, `onRoll: (key: string) => void`, `onContinue: (key: string) => void`. Keep `items` / `connectionLine` / `reducedMotion` unchanged.

- [ ] **Step 1** — author the two prop files + the `MessageStreamProps` additions + the `contract/session/index.ts` re-export block (the two new prop types + the three `roll-reveal` type re-exports). `pnpm --filter @mythrun/client-core typecheck` + the barrel test → PASS.
- [ ] **Step 2 — commit** `feat(MYT-93): contract prop types for RollCard / DieSpin + MessageStream reveal props`.

---

## Phase C — `@mythrun/ui` components

> Each component: a presentational component importing props from `@mythrun/client-core/contract`, a Storybook story + tests, square register, two-faces-only, responsive to ~375px, reduced-motion honored. Append to `ui/src/index.ts` (value) + the `ui` prop-type re-export block (append-only).

### Task 4: `DieSpin` — the stepped 2D outlined d20

**Files:** `frontend/ui/src/components/DieSpin/{DieSpin.tsx,DieSpin.stories.tsx,DieSpin.test.tsx}` + `ui/src/index.ts`.

**Behavior (spec §5):** a flat 2D **outlined** d20 drawn as an inline SVG path in the pixelarticons 24-grid outline vocabulary (`viewBox="0 0 24 24"`, `currentColor`). This is a NEW brand glyph — **no pixelarticons dice exists** (searched 2026-07-14) and Miklos directed "a 2D outline in some 1-bit register, spun," so authoring it here is SANCTIONED by spec §5 (distinct from the general "no hand-authored glyphs" rule — this is a deliberate new mark, not a lazy substitute for an existing icon). **This story is its canonical reference thereafter.** When `spinning`, it runs a STEPPED rotation — **8 steps/revolution, ~1s, discrete 45° increments, never a smooth CSS interpolation** — then calls `onSpinComplete`. When `result !== null` and not spinning, the numeral **stamps in the die centre in `--font-ui`**. `reducedMotion` → no spin, `onSpinComplete` fires immediately (instant land). The die SVG is `aria-hidden`; a polite live region carries `resultLabel` when the result lands.

**Design (pin the tunable constants — the story is canon):**
```tsx
// STEP budget: 8 steps × ~125ms ≈ one ~1s revolution. Pixel-honest — each step
// is a discrete 45° jump, NOT a smooth transform transition (the motion analog of
// the brand's stepped Bayer dither). Tunable; the DieSpin story is the canonical
// reference for the end-polish pass (spec §5).
const STEPS_PER_REV = 8
const STEP_MS = 125
const SPIN_STEPS = STEPS_PER_REV // one full revolution

export const DieSpin = forwardRef<HTMLDivElement, DieSpinProps>(function DieSpin(
  { spinning, result, reducedMotion, onSpinComplete, resultLabel }, ref,
) {
  const [step, setStep] = useState(0)
  const doneRef = useRef(onSpinComplete)
  doneRef.current = onSpinComplete

  useEffect(() => {
    if (!spinning) return
    if (reducedMotion) { doneRef.current(); return }   // no churn — land instantly
    let n = 0
    setStep(0)
    const id = setInterval(() => {
      n += 1
      setStep(n % STEPS_PER_REV)
      if (n >= SPIN_STEPS) { clearInterval(id); doneRef.current() }
    }, STEP_MS)
    return () => { clearInterval(id) }
  }, [spinning, reducedMotion])

  const angle = spinning && !reducedMotion ? (step * 360) / STEPS_PER_REV : 0
  const showResult = result !== null && !spinning
  // <div> (ref, relative square) →
  //   <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor"
  //        style={{ transform: `rotate(${angle}deg)` }}> {D20_OUTLINE_PATH} </svg>
  //   showResult → an absolutely-centred <span class="font-ui …">{result}</span>
  //   + a VisuallyHidden role=status/polite carrying `resultLabel` when showResult
})
```
The `D20_OUTLINE_PATH` is the one authored outline (a 24-grid icosahedron silhouette + a few internal facet strokes); co-locate it as a `const` in the component. Exact geometry + `SPIN_STEPS` are the story-tuned constants (accepted visual debt under the deferred-review regime, spec §7 — see Spec Ambiguity #5).

- [ ] **Step 1 — failing tests:** (a) idle (`spinning:false`, `result:null`) renders the die SVG, no numeral; (b) `result` set + not spinning renders the numeral in a `font-ui` node AND a polite live region carrying `resultLabel`; (c) with motion, `spinning:true` runs the stepped interval (advance fake timers `SPIN_STEPS × STEP_MS`) and calls `onSpinComplete` exactly once — assert the SVG carried ≥2 DISTINCT `rotate()` transforms across steps (stepped, not static); (d) under `reducedMotion`, `spinning:true` calls `onSpinComplete` immediately with NO interval churn and NO rotation; (e) the die SVG is `aria-hidden`; (f) no `.rounded-full` / circle; (g) unmount mid-spin clears the interval (no post-unmount setState). Run → FAIL.
- [ ] **Step 2 — implement** (use `vi.useFakeTimers()` in the timing tests; `forwardRef`; `VisuallyHidden` for the live region). Keep the module < 120 lines.
- [ ] **Step 3 — stories:** `Session/DieSpin` — Idle, Spinning (a self-driving demo that flips `spinning`), Result (stamped), Reduced-motion (instant). Barrel-export `DieSpin` + `DieSpinProps`.
- [ ] **Step 4 — run** the DieSpin test (100×4 scoped) → PASS. **Commit** `feat(MYT-93): DieSpin — stepped 2D outlined d20`.

### Task 5: `RollCard` — the in-stream dice moment

**Files:** `frontend/ui/src/components/RollCard/{RollCard.tsx,RollCard.stories.tsx,RollCard.test.tsx}` + `ui/src/index.ts`.

**Behavior (spec §5):** renders a `skill_check` or `dice_roll` transcript item as the in-stream card, composing DS primitives (`Button` `onPress`, `Stack`/`Box`, `Text`) + `DieSpin`. Square/paper register, all numerics `--font-ui`.
- **Header (skill variant):** `skill` (e.g. "Perception"), `characterName` + rollType **posture** tag (advantage/disadvantage from `labels`; normal shows none), and the `context` line (DATA — quiet sub-line). **Never render `constraint`** (the prose seed).
- **Header (dice variant):** the dice notation `${count}d${sides}` — no skill/DC/context.
- **`idle` phase:** the header + a **Roll** `Button` (`labels.roll`). Press → local `spinning:true`.
- **`spinning` (local):** `DieSpin spinning result={dieNumber} reducedMotion onSpinComplete`. On complete → `onRoll()` (commits `revealed` in the reducer) + clear local spinning.
- **`revealed` / `released`:** `DieSpin result={dieNumber}` stamped, and the readout **under it in `--font-ui`**: modifier (signed), total, `DC {dc}`, and the outcomeTier word rendered as **typographic WEIGHT** (`fail` → normal, `success` → medium, `great_success` → semibold — a `data-tier` attribute + a weight class; the tier signal is weight, NEVER colour). For `dice_roll`: just the stamped total + the `NdM` notation, **no DC/tier, no Continue, no prose gate**.
- **Continue (skill_check, `revealed` only):** a **Continue** `Button` (`labels.continue`) → `onContinue()`. Absent once `released` (and absent for dice_roll).

**Die number (pin):** skill_check stamps the effective natural roll = `total − modifier` (the used d20; matches adv/dis without exposing both dice on the face — the two dice can ride a small mono note beside the readout). dice_roll stamps `frame.total`.

- [ ] **Step 1 — failing tests** (RTL + userEvent + jest-axe; fixtures from the MYT-92 `MessageStream.test.tsx` skill_check/dice_roll frames): (a) `idle` skill_check renders skill + context + Roll, and does NOT render `constraint` anywhere; (b) pressing Roll spins then calls `onRoll` once (advance timers) — and does NOT call `onContinue`; (c) `revealed` renders the readout (modifier/total/`DC 12`/tier word) with the tier as a weight class (`data-tier="success"`) and a Continue button; pressing Continue calls `onContinue`; (d) `released` renders the readout with NO buttons; (e) a REPLAYED card passed at `phase="released"` renders revealed immediately (no Roll); (f) dice_roll variant renders `2d20` + total, NO DC/tier, NO Continue; (g) `reducedMotion` Roll lands instantly (no interval) and shows the readout; (h) all numerics carry `font-ui`; no `.rounded-full`; (i) no axe violations idle/revealed/released. Run → FAIL.
- [ ] **Step 2 — implement.** Local `useState` for `spinning`; `phase` drives the rest. Keep functions < 50 lines (extract `dieNumber(item)`, a `readout` sub-render, a `header` sub-render). Compose `Button`/`Text`/`Stack` — no raw interactive elements.
- [ ] **Step 3 — stories:** `Session/RollCard` — Skill idle / Skill revealed (each tier: fail/success/great_success, shown as weight) / Skill released / Dice roll / Reduced-motion / 375px. Barrel-export `RollCard` + `RollCardProps` (+ `RollCardLabels`, `DieSpinProps` re-exports as needed).
- [ ] **Step 4 — run** the RollCard test (100×4 scoped) → PASS. **Commit** `feat(MYT-93): RollCard — in-stream skill_check / dice_roll dice moment`.

---

## Phase D — MessageStream dispatch + play-route wiring

### Task 6: Extend `MessageStream` — cards + prose gate (edit committed 92 component)

**Files:**
- Modify: `frontend/ui/src/components/MessageStream/MessageStream.tsx`
- Modify (committed 92 tests/stories — the rendering seam changed): `frontend/ui/src/components/MessageStream/MessageStream.test.tsx`, `frontend/ui/src/components/MessageStream/MessageStream.stories.tsx`

**Interfaces:**
- Consumes: the extended `MessageStreamProps` (Task 3) — `rollReveal: RollRevealView`, `rollLabels`, `onRoll`, `onContinue`.
- Produces: the same scroll container, with the `renderItem` dispatch EXTENDED: `skill_check` / `dice_roll` → `<RollCard>` (phase from `rollReveal.phaseByKey[item.key]`, callbacks bound to `item.key`); a `dm` item whose `turnId ∈ rollReveal.gatedTurnIds` renders **nothing** (the prose buffer); `ledger_update` / `mode_change` / `combat_started` / `combat_resolved` **KEEP** their terse mono system line (unchanged — only the two card kinds move).

**Design (pin):** the gate is a pure read of the passed-in `gatedTurnIds` Set — MessageStream stays presentational (no client-core runtime import). The `data-mechanical` mono-line path now covers only the four non-card mechanical kinds. `MechanicalItem`'s type narrows accordingly. The auto-follow effect is unchanged (a gated dm item contributes no height until released; on Continue the released prose grows the tail and auto-follow catches it while at bottom). `needsDivider` is unaffected (it compares turnIds; a gated null dm node just yields an empty Fragment).

```tsx
// renderItem (extended) — the RENDERING seam (spec §7). Cards dispatch to RollCard;
// a gated dm item (its turn's skill_check not yet continued) renders null — the
// post-check prose buffer. The four non-card mechanical kinds keep their mono line.
function renderItem(
  item: TranscriptItem,
  reveal: RollRevealView,
  labels: RollCardLabels,
  reducedMotion: boolean,
  onRoll: (key: string) => void,
  onContinue: (key: string) => void,
): ReactNode {
  if (item.kind === 'dm') {
    if (reveal.gatedTurnIds.has(item.turnId)) return null   // buffered until Continue
    return <DmMessage text={item.text} streaming={item.streaming} />
  }
  if (item.kind === 'player') { /* unchanged */ }
  if (item.kind === 'skill_check' || item.kind === 'dice_roll') {
    return (
      <RollCard
        item={item}
        phase={reveal.phaseByKey[item.key] ?? 'idle'}
        reducedMotion={reducedMotion}
        labels={labels}
        onRoll={() => { onRoll(item.key) }}
        onContinue={() => { onContinue(item.key) }}
      />
    )
  }
  // ledger_update / mode_change / combat_* → the terse mono line (unchanged).
  return <p data-mechanical={item.kind} className={cn(TYPE_ROLE_CLASS.meta, 'py-[var(--space-1)] text-center')}>{mechanicalText(item)}</p>
}
```
`mechanicalText` loses its `skill_check` / `dice_roll` arms (now cards); narrow `MechanicalItem` to the four remaining kinds.

- [ ] **Step 1 — update the committed tests (RED first):** in `MessageStream.test.tsx`, (i) thread the new required props through every `render` (a `NO_REVEAL = { phaseByKey: {}, gatedTurnIds: new Set() }` helper + a stub `rollLabels` + no-op callbacks); (ii) REMOVE `skill_check` / `dice_roll` from the "renders every mechanical kind as a mono line" + "formats each mechanical line" cases (they now assert a `RollCard`, not a `data-mechanical` line) — keep `ledger_update` / `mode_change` / `combat_*` asserting the mono line; (iii) add cases: a `skill_check` item renders a `RollCard` (a Roll affordance) at `phaseByKey` `idle`; a `dm` item whose `turnId ∈ gatedTurnIds` is NOT in the DOM, and is present when un-gated; the reveal callbacks fire with `item.key`. Run → FAIL (props/JSX not yet added).
- [ ] **Step 2 — implement** the `renderItem` extension + the `mechanicalText` narrowing + thread the props from the `MessageStream` signature into the `items.map`. Keep every function < 50 lines.
- [ ] **Step 3 — stories:** extend `MessageStream.stories.tsx` — a transcript with a live skill_check (idle) gating its dm prose, and one already `released` showing the prose. Pass a real `buildRevealView`-shaped `rollReveal`.
- [ ] **Step 4 — run** the MessageStream test (100×4 scoped) + the story → PASS. **Commit** `feat(MYT-93): MessageStream — RollCard dispatch + post-check prose gate`.

### Task 7: Play-route wiring (`session-shell`) + i18n

**Files:**
- Modify: `frontend/src/routes/play/session-shell.tsx`
- Modify: web i18n (`common.json` + `descriptions.ts` — append-only `[ph:]` keys under `play.roll.*`)
- Test: `frontend/src/routes/__tests__/play.test.tsx` (extend) + `frontend/src/routes/play/__tests__/*` as the shell test home dictates; `resources.test.ts` (i18n drift).

**Interfaces:**
- Consumes: `useRollReveal`, `buildRevealView` (client-core); `useTranslation`; the extended `MessageStream`.
- Produces: the shell computes the reveal view + label bundle and threads them into `MessageStream`.

**Design:**
```tsx
const reveal = useRollReveal()
const rollReveal = useMemo(() => buildRevealView(items, reveal.state), [items, reveal.state])
const rollLabels: RollCardLabels = useMemo(() => ({
  roll: t('play.roll.roll'),
  continue: t('play.roll.continue'),
  tier: { fail: t('play.roll.tier.fail'), success: t('play.roll.tier.success'), great_success: t('play.roll.tier.greatSuccess') },
  dc: t('play.roll.dc'),
  advantage: t('play.roll.advantage'),
  disadvantage: t('play.roll.disadvantage'),
  dieResult: t('play.roll.dieResult'),
}), [t])
// …<MessageStream items connectionLine reducedMotion
//     rollReveal rollLabels onRoll={reveal.roll} onContinue={reveal.advance} />
```
`[ph:]` keys to add (lockstep): `play.roll.roll`, `play.roll.continue`, `play.roll.dc`, `play.roll.advantage`, `play.roll.disadvantage`, `play.roll.dieResult`, `play.roll.tier.fail`, `play.roll.tier.success`, `play.roll.tier.greatSuccess`. Values are `[ph: …]` placeholders (MYT-100 is the copy pass).

**Non-blocking pin:** a pending (un-continued) card does NOT disable `SessionInput` — the player may keep typing (spec is silent; keep the calm default). Note it in the shell header comment.

- [ ] **Step 1 — failing tests** (drive the shell with a fake `useLiveSession` returning items incl. a live skill_check + its dm prose): (a) the skill_check renders a `RollCard` and its dm prose is initially absent (gated); (b) rolling then continuing (advance timers for the spin) reveals the numbers then renders the dm prose; (c) a replayed skill_check (frame with `seq`) renders released with prose shown, no Roll; (d) `resources.test.ts` passes with the new `play.roll.*` keys in both resource files. Run → FAIL.
- [ ] **Step 2 — implement** the shell wiring + the `[ph:]` keys in lockstep. Keep the shell < 200 lines / functions < 50 (extract the `rollLabels` memo builder if it pushes the limit).
- [ ] **Step 3 — run** the shell/route tests + `resources.test.ts` → PASS. **Commit** `feat(MYT-93): play-route wiring — reveal view + labels into MessageStream`.

---

## Phase E — verification

### Task 8: Merged battery + E2E done-when smoke

**Files:** none new (verification). A Playwright E2E under the MYT-92 smoke home if one exists; otherwise a documented curl/WS + psql wire-walk per the CLAUDE.md dev-tool-E2E rule.

- [ ] **Step 1 — full batteries:** `pnpm --filter @mythrun/client-core test`, `pnpm --filter @mythrun/ui test`, the web route tests; `pnpm typecheck`; `pnpm lint` (whole `src`, for the type-aware rules); scoped coverage at 100×4 on the new source (`roll-reveal.ts`, `DieSpin`, `RollCard`, the `MessageStream` diff, the shell diff); the Storybook browser sweep on the new/changed stories (a11y contrast + overflow gates). All green.
- [ ] **Step 2 — E2E done-when (spec §5, verbatim):** on the live dev stack, a real session includes a skill check:
  - the `RollCard` arrives **carrying the full result** (drive a check-provoking message as in Task 1);
  - the spin plays (and the reduced-motion path lands instantly — verify with `prefers-reduced-motion` emulation);
  - the **revealed numbers match the server's roll** — `psql` the `session_messages` skill_check row `content.output` and assert the card's die (`total − modifier`) + modifier/total/DC/tier equal the persisted values;
  - the **outcome prose stays HIDDEN until Continue**, and after Continue it renders (streams if the turn is still arriving — see Spec Ambiguity #1).
  - **Assert observable END STATE** (the RollCard revealed with the psql-matched numbers, the prose present only post-Continue), not "page loaded / no errors" (the Playwright-asserts-end-state rule).
- [ ] **Step 3 — wiki sync:** the controller dispatches the `docs/wiki/AUTHORING.md` subagent (parameterized with MYT-93) before the merge's final push (the controller owns the push per the worktree flow).
- [ ] **Step 4 — commit** any verification scaffolding as `test(MYT-93): dice/skill-check E2E smoke + merged battery`.

---

## Spec ambiguities (surfaced — NOT silently resolved)

1. **"then streams" semantics (the load-bearing one).** The done-when says the outcome prose "stays hidden until Continue **and then streams**." This plan uses a **pure render gate**: `useSession` folds `text_delta` normally; the gate declines to render the `dm` item until Continue, then renders it in whatever wire-state it is in. Because a turn streams from the server in a few seconds while the human takes ~3s to Roll→spin→Continue, the prose has usually SETTLED by Continue, so it **appears** rather than token-streaming (it token-streams only if Continue is pressed before `turn_end`). The alternative — buffering the post-check deltas inside `useSession` and **replaying them token-wise on Continue** — guarantees a dramatic stream but (a) modifies the 92 keystone hook, and (b) is exactly the "fake arrival with per-character timers" the committed `DmMessage.stories.tsx` cautions against. **Recommendation: the pure gate (A).** Needs the team lead's call: is "appears settled in the common case" acceptable, or is a guaranteed re-stream required?
2. **Pre-check lead-in prose (verify in Task 1).** The gate is clean when the `skill_check` frame precedes the outcome `text_delta` (the FT prompt's "call the tool first" → the dominant order). If the model writes prose BEFORE the tool call, the committed reducer merges lead-in + outcome into ONE `dm` item positioned BEFORE the card, so gating hides the lead-in too and the released prose lands above the card. Task 1 measures how often this happens. If common, the fix is a reducer split at mechanical boundaries — a change to 92's committed reducer that the spec's "extend RENDERING only" would need to relax (controller coordination). Flagged, not silently designed-around.
3. **`dice_roll` interaction model.** This plan makes `dice_roll` **reveal-only** (spin + total, NO Continue, NO prose gate — the flavor variant per spec §5), while `skill_check` gets the full Roll→reveal→Continue theater. The spec is light on `dice_roll` beyond "the same card minus skill/DC dressing." Confirm the reveal-only model (vs. also gating prose after a damage roll).
4. **Multi-check turn.** "Everyone rolls Perception" emits N `skill_check` frames sharing one `turnId` (verify in Task 1). This plan keys reveal by ITEM KEY (N independent cards) and gates the shared prose until ALL are `released`. Open sub-question: one shared Continue vs. a Continue per card. Minor; the plan's default (each card carries its own Continue; the last one released opens the gate) is safe but worth a nod.
5. **The d20 is a new hand-authored glyph.** Sanctioned by spec §5 (no pixelarticons dice; Miklos-directed) and the `DieSpin` story is its canonical reference. Under the deferred-design-review regime (§7) there is NO per-feature visual stop, so the first cut lands structurally correct (stepped, 8/rev, ~1s, reduced-motion instant, `--font-ui` numeral) with die geometry + step count as story-tuned constants for the end-polish pass. Flagging because a brand-new visual mark is the kind of thing Miklos eye-tunes (the canonical-prototype rule) — if he wants an early look, the `DieSpin` story is where.

---

## Filed beads (not built here)

- *(none new)* — MYT-93 opens no follow-up scope beyond the ambiguities above. The recap / `member_joined` beads are MYT-92's; MYT-94 (entity highlighting + sidebar) is the other wave-2 issue and shares the `MessageStream` + play-route surfaces per §7 (serialized by the controller — 93 lands cards first).

---

## Self-review

**Spec §5 coverage:** ONE server-resolved frame + NO client→server roll (no `roll_complete`, no backend work) → the Global Constraints + Task 2 design + Task 8 verify; reveal state presentation-side (client-core reducer, not `useSession`) → Task 2; post-check prose client-buffered + released on Continue → Task 2 `gatedTurnIds` + Task 6 gate + Task 7 wiring (Spec Ambiguity #1 flags the "then streams" nuance); `DieSpin` (2D outlined d20, stepped 8/rev ~1s, result stamps centre, reduced-motion instant, numerals `--font-ui`) → Task 4; `RollCard` (skill/context/posture + Roll → spin → reveal mod/total/DC/tier as weight + Continue; dice_roll simple variant) → Task 5; MessageStream dispatch extension → Task 6; play-route wiring + i18n `[ph:]` → Task 7; verify-first (drive one real skill_check frame, record verbatim) → Task 1; E2E done-when verbatim (card carries full result, spin plays, numbers psql-match, prose hidden until Continue then streams, reduced-motion) → Task 8. ✅ all mapped.

**Enforced ignorance / ZFC:** no new client/server frame type, no read surface; the reveal is deterministic UI mechanism (sanctioned ZFC exception); `constraint` is never rendered on the card (it is the prose seed). ✅

**§7 shared-surface discipline:** the reducer shape is untouched (MYT-93 extends RENDERING via `MessageStream`'s `renderItem` + the play-route wiring only); the committed `MessageStream` tests are updated in-task because the rendering seam legitimately changed; barrels + i18n append-only; `MessageStreamProps` extended (not restructured); the shared `MessageStream` + play-route surfaces are serialized with MYT-94 by the controller (93 first). ✅

**R1 portability:** `DieSpin` / `RollCard` read prop TYPES from `@mythrun/client-core/contract`; the reveal phase/gate are computed by client-core selectors in the web route and passed to `MessageStream` as plain data (`RollRevealView`) — no UI-side runtime import of the reducer. ✅

**Type consistency:** `RollPhase` / `RollRevealState` / `RollRevealView` / `CardItem` (roll-reveal.ts), `RollCardProps` / `RollCardLabels` / `DieSpinProps` (contract), and the extended `MessageStreamProps` (`rollReveal` / `rollLabels` / `onRoll` / `onContinue`) are used consistently across Tasks 2–7. `useRollReveal().advance` (not `continue`) avoids the JS keyword; `onContinue` is the neutral callback name at the component seam.

**Placeholder scan:** load-bearing code inline (the full `roll-reveal.ts` reducer + selectors + hook, the `DieSpin` stepped-timer core, the `RollCard` phase structure + die-number rule, the `MessageStream` `renderItem` gate). No "TBD"; the die geometry + spin constants are explicitly the story-tuned constants (Spec Ambiguity #5), not omissions.
