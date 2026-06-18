# MYT-75 — Combat Layer 1 (single-shot resolver + the mode seam)

> **Status:** approved at brainstorm 2026-06-18. The **combat debug shell** — it proves the exploration↔combat plumbing end-to-end *with real stakes* but *without a rules engine*. Spec basis: Combat Engine §2 (Debug Shell), §5 (state machine), §11 (handoff); Multiplayer Session Runtime §17.2 (tool-calling contract), §17.3 (shared ledger). This is **not** the round-by-round combat *mode* — that (turns, player actions, enemy stat blocks, the React combat screen) is deferred to the real combat mode / L2.

**Goal:** A player attacks → combat triggers → the session flips to **combat mode** → the whole fight resolves in a **single shot** (dice decide the outcome, the FastThinker narrates it) → the shared character ledger is updated → **any party member** clicks "okay" → the session flips back to **exploration** and a `CombatSummary` hands off to the ST + Scribe. The player-facing combat *screen* is a Frontend ticket; MYT-75 ships the backend it consumes.

---

## Where this sits

The session already has a first-class mode. `redis/session-state.ts` defines `SessionMode = 'exploration' | 'combat'` and carries `mode` in the state blob — MYT-65 stubbed it to always-`exploration` ("`combat` arrives with the combat engine … the combat keys are still OUT"). **MYT-75 activates that seam**: it starts exercising `combat`, adds the `session:{cId}:combat` Redis key, and broadcasts mode transitions so clients re-render. The combat *resolver* is a placeholder — when the real round-by-round mode lands, it grows into these same two tools and the same mode seam; the single-shot resolution is what gets replaced.

The two combat tools ride the **existing FastThinker tool loop** (`session/tiers/ft-tools.ts` already carries the "extension point for MYT-70/72/**75**"). The outcome decision **reuses the skill-check pattern** (`session/skill-check.ts`, Principle #5): a Haiku call pre-generates a tiered outcome table, deterministic code rolls, and the matched tier is injected into the FT as a constraint. HP/condition changes apply to the **shared character ledger** the Rules Lawyer already owns (`session/rules-lawyer-vitals.ts`), so resources carry seamlessly across the mode switch.

---

## Decisions

- **D1 — Single-shot, not round-by-round.** A whole encounter resolves in one beat. There is no per-combatant turn loop, no `combat_continues` flag, no repeated round resolution. This is the deliberate placeholder for the unbuilt combat *mode*.
- **D2 — Activate the existing mode seam.** Exercise `mode: 'combat'` in the session-state blob; add the `session:{cId}:combat` key (a `CombatState` record); broadcast a `mode_change` event on every transition. The frontend (a separate ticket) swaps the whole screen on `mode_change`.
- **D3 — Two-beat FT tools.** `initiate_combat` flips mode + determines the outcome; `resolve_combat` narrates the determined tier + reports the mechanical deltas. Both fire **in one FT turn** via the existing interleaved tool loop (§17.2) — *not* a separate generation. The two tools stay distinct so the real round-by-round mode can grow into them.
- **D4 — Dice decide the outcome, never the LLM (Principle #4/#5).** A whole fight is one big skill check: Haiku rates the encounter → DC + tiered outcomes; a mechanical roll (party capability + d20 vs DC) selects the tier; the FT narrates the **matched** tier. The LLM never decides win/loss or rolls a number. Mirrors `resolveSkillCheck`.
- **D5 — Auto resolution only.** The FT drives resolution; no human-typed "manual" mode + Haiku parser (a dev affordance with no production role — there is no human DM). Drive/verify via the dev-tool + a real-LLM smoke.
- **D6 — Any member resumes the party.** The first player to send the resume ("okay") action flips the whole session back to exploration. Combat is a shared party beat; the `CombatSummary` persists so the next prose recaps it.
- **D7 — Initiative rolled + broadcast on combat start.** Mechanical roll via the dice engine, stored + broadcast — it gives the screen-shift its "roll initiative" flourish and is forward-compat scaffolding, but it **sequences nothing in L1** (single-shot has no turns).
- **D8 — Enemies are narrative-only.** `initiate_combat` carries enemies as `{name, description, count}` — no stat blocks, no HP pool. Casualties are tier-bounded and FT-declared (`dead | unconscious | fled`). Only **PC** HP/conditions hit the ledger.
- **D9 — Defeat is recoverable by default.** Tiers run routed → pyrrhic → costly → decisive; defeat tiers default to non-fatal (rout / capture / downed). A single bad roll never produces a blanket TPK; PC death is reserved for the worst tier and remains rare.
- **D10 — Lean L1 `CombatSummary`, assembled deterministically.** A subset of §11 (outcome, description, casualties, hpChanges, conditionsRemaining, loot) built from the selected tier + `resolve_combat`'s deltas — no extra LLM call. The combat turn **rides the normal post-turn tail** (the worker already enqueues ST-eval + Scribe after every turn's `persistTurn`, `turn-worker.ts`), so the combat is processed by ST/Scribe **once, at turn-end** — there is **no separate ST/Scribe handoff at resume** (that would double-extract facts; corrected from the original §3). The `CombatSummary` is stored on the `CombatState` and surfaces to the next turn's ST context after resume; **resume is purely the mode flip** (§3).
- **D11 — Combat tool rows MUST be registered in the transcript codec; no migration (`message_type` is free TEXT).** The two combat tools appear as `tool_call`/`tool_result` parts in the turn's `AssistantMessage` (the consume loop pushes *every* tool result, `fast-thinker.ts`), and `assistantToRows` **throws `TranscriptCorruptError` on any tool name not in `TOOL_TO_KIND`** (`transcript-codec.ts`) — so without codec registration, **every combat turn crash-fails at persist**. MYT-75 adds `initiate_combat`/`resolve_combat` to `DM_MESSAGE_TYPES` + `TOOL_TO_KIND` + `KIND_TO_TOOL` (new kinds `combat_initiate` / `combat_resolve`, kind === tool name — the MYT-70 ledger-tool pattern; they persist `{toolCallId, input, output}` JSON). **No migration is needed**: `session_messages.message_type` is free `TEXT` with no CHECK (migration 024 — "the repo layer owns the kind set"), and the 74d FTS partial index excludes the new kinds by construction (its predicate is `dm_text`/`player_message` only), so they're not searchable (correct — they're tool metadata, not prose). Only the transcript-codec test updates. The fight's player-facing *prose* still persists as an ordinary `dm_text` row (replays on reconnect; in the 74d searchable corpus). (Corrects the original D11's "no codec change.")
- **D12 — Side-effects live in the consume loop + at persist, NOT in the tool `execute`.** A tool `execute` is a **pure resolver that returns DATA ONLY** — `FtToolDeps` has no `SessionState`/`campaignId`/emitter, the SDK runs `execute` *ahead of the consumer*, and an eager durable Redis write from `execute` would break the turn **recovery invariant** (`session-controller.ts`: nothing durable is written between turn-load and `persistTurn`; a mid-turn crash must roll back cleanly). So: `initiate_combat.execute` *computes* the outcome (Haiku table + roll → tier + initiative) and returns it as data; the **consume loop** emits the combat frames (§ below); the **durable mode flip + `CombatState` write happen at `persistTurn`** (part of the atomic turn commit, lock-held, idempotent on re-delivery). The client flips immediately on the transient `mode_change` frame; the durable Redis mode flips at commit. (Corrects the original §1/§2 "the mode mutation happens in the resolver.")
- **D13 — The dice-selected tier is binding: the resolver enforces a mechanical cost envelope.** To keep the LLM from re-deciding the outcome via the deltas (the skill-check guarantee), each tier carries a **required cost envelope** (e.g. `pyrrhic` ⇒ ≥1 PC reduced to 0 HP; `costly` ⇒ aggregate PC HP loss ≥ X% of party max; `routed` ⇒ the party does not win + a cost; `decisive` ⇒ no PC casualties). `resolve_combat` validates the FT's `hp_changes`/`casualties` against the envelope and, on a contradiction (e.g. tier `pyrrhic` but no PC dropped), **clamps/augments to satisfy the envelope** rather than applying the FT's under-stated deltas verbatim. The dice own the *outcome*; the FT owns the *telling* and the specifics *within the envelope*.
- **D14 — Combat mode gates the inbound trigger path.** While the session is in `combat` mode (awaiting resume), the WS inbound handler **drops/queues normal `player_message` turns** (mirroring the existing `isEnding` drop-gate, `ws-session.ts`) — only `resume_combat` is accepted. Otherwise a player typing mid-result re-arms the dm-trigger and fires a phantom exploration turn over the unresolved fight. This is what makes `mode` a *real* server-side mode, not just a display flag.
- **D15 — Resume is once-only (SET-NX interlock), reads `:combat`, and `:combat` is TTL-managed.** Any-member resume (D6) is guarded by a `tryMarkResumed` SET-NX claim (mirroring `tryMarkEnding`, `session-state.ts`) so two simultaneous "okay"s flip the mode + clear `:combat` exactly once. The reconnect/replay path **reads `session:{cId}:combat`** and emits a synthetic `combat_resolved`/state frame so a member who reconnects mid-fight sees the result (not a blank screen). `:combat` is added to `refreshTtls` so a suspend mid-fight doesn't lapse the key and wedge the session in `combat` mode with no result.

---

## 1. The mode seam

`mode` is authoritative in `session:{cId}:state` (already there) and gates client rendering. MYT-75 adds:

- **`session:{cId}:combat` — a `CombatState` record** (JSON, TTL'd + checkpointed like other session state; cleared on resume):

  ```ts
  interface CombatState {
    readonly status: 'resolving' | 'resolved'
    readonly enemies: ReadonlyArray<{ name: string; description: string; count: number }>
    readonly environment: string
    readonly surprise: 'none' | 'players_surprised' | 'enemies_surprised'
    readonly initiative: ReadonlyArray<{ combatant: string; roll: number }> // flavor only (D7)
    readonly outcome: CombatOutcome      // the dice-selected tier (§4) — set at initiate
    readonly result: CombatResult | null // narration + applied deltas — set at resolve
  }
  ```

  (`CombatOutcome` = the §4 tier + its envelope; `CombatResult` = the applied deltas + the assembled `CombatSummaryL1` of §5.)

- **Three new server frames** — `mode_change ({ from, to, reason })`, `combat_started ({ enemies, initiative })`, `combat_resolved ({ narration, summary })` — broadcast so clients re-render. **They are not free** — each new frame kind is hand-wired across the emission seam: a `TurnEmitter` method (`tiers/types.ts`), a `TurnPublisher.emitFor` branch (`turn-publisher.ts`), a branch in the consume loop's `emitFrameForResult` dispatcher (`fast-thinker.ts`), and a `ServerFrame`/`SERVER_FRAME_TYPES` entry in the wire contract (`contract/session-events.ts`, where `combat_*` frames are currently *deliberately* absent). The plan enumerates all four. Frames emit in the **consume loop in stream order** (never execute-side — the SDK runs `execute` ahead of the consumer), so the combat tools' `execute` returns the frame-shaping data and the loop emits.

- **The durable mode flip + `CombatState` write happen at `persistTurn`** (D12), as part of the atomic turn commit (lock-held, idempotent on BullMQ re-delivery), **not** in the tool `execute`. The client sees combat mode immediately via the transient `mode_change` frame; Redis `mode` flips durably at commit. `setState` is a blind last-write-wins overwrite (`session-state.ts`) and `resolveWorldId` already does an intra-turn RMW on `:state`, so the persist-time mode write must **merge** (atomic Lua CAS or a single read-modify-write sequenced after the worldId write), not blind-overwrite.

Transitions: `exploration → combat` (committed at the `initiate`+`resolve` turn's persist); `combat → exploration` (at resume).

---

## 2. The combat tools (`ft-tools.ts` MYT-75 extension point)

Both are `tool({ description, inputSchema, execute })` **pure resolvers — `execute` returns DATA ONLY, mutates no session state, emits no frames** (the file's load-bearing rule). The mode flip, the `CombatState` write, and the frame emission happen **outside** `execute` — frames in the consume loop, durable state at persist (D12). `execute` *may* do the Haiku call + dice roll (pure computation returning data, exactly like the skill-check resolver, which nests a Haiku call in `execute` and forwards the SDK `abortSignal` — `initiate_combat` does the same).

### `initiate_combat`

```ts
input: {
  enemies: Array<{ name: string; description: string; count: number }>
  environment: string
  surprise: 'none' | 'players_surprised' | 'enemies_surprised'
}
```

`execute` (pure — returns data): roll initiative (dice engine; enemies have no DEX, so a bare d20 — D7, flavor only); **determine the outcome** (`resolveCombat`, §4 — Haiku rates the encounter from the enemies + the *public* party ledger snapshot, then a deterministic roll selects the tier; `abortSignal` forwarded; fail-soft fallback table). Returns `{ enemies, environment, surprise, initiative, outcome }` (the selected tier + its envelope) **plus the tier as a narration constraint** for the FT ("the encounter resolves as a *pyrrhic victory*: <tier prose>. Narrate it; report the results consistent with this outcome.").

Consume-loop + persist (outside `execute`): emit `mode_change(exploration→combat)` + `combat_started({ enemies, initiative })`; at persist, write `mode='combat'` (merged) + `CombatState{ status:'resolving', enemies, environment, surprise, initiative, outcome, result:null }`.

### `resolve_combat`

```ts
input: {
  narration: string
  hp_changes: Array<{ combatant_name: string; damage: number; healing: number }>
  conditions_applied: Array<{ combatant_name: string; condition: string }>
  conditions_removed: Array<{ combatant_name: string; condition: string }>
  casualties: Array<{ combatant_name: string; fate: 'dead' | 'unconscious' | 'fled' }>
}
```

`execute` (pure — returns data):
1. **Partition by name.** Resolve each `combatant_name` against the campaign's PCs (`findLedgerCharacterByName` / party participants) vs the declared enemies. PC entries → ledger deltas; enemy entries → narrative-only; an unresolvable name (FT typo/hallucination) is dropped with a logged warning, never written.
2. **Enforce the tier envelope (D13).** Validate the PC `hp_changes`/`casualties` against the selected tier's required cost envelope; clamp/augment to satisfy it (e.g. tier `pyrrhic` but the FT dropped no PC → the resolver applies the envelope's minimum, deterministically choosing a target). The applied deltas are the **reconciled** set, not the FT's verbatim numbers.
3. **PC casualty representation (no `dead` state in L1).** The ledger has no death column and no `dead` condition (`ConditionName` is the PHB set + exhaustion); `writeHp` floors at 0 and auto-applies/clears `unconscious`. So a PC casualty (`fate:'unconscious'` or, narratively, `'dead'`) is represented mechanically as **`hp=0` → auto-`unconscious`** — the existing 0-HP representation. `fate:'dead'` (only reachable on the worst tier, D9) is a **narrative label recorded in the `CombatSummary`**, not a distinct ledger state; real death/dying lands with the L2 rules engine. Enemy casualties are narrative-only (no ledger row).
4. Returns the reconciled deltas + the assembled `CombatSummaryL1` (§5) as data.

Consume-loop + persist (outside `execute`): apply the reconciled PC deltas to the shared ledger via the Rules Lawyer vitals path (`rules-lawyer-vitals.ts`) — one journal-idempotent write per PC, keyed `(turnId, toolCallId, characterId)`, each emitting its `ledger_update` frame; emit `combat_resolved({ narration, summary })`; persist `narration` as a `dm_text` row + the two combat tool rows (D11 codec kinds); at persist, set `CombatState{ status:'resolved', result }`.

`resolve_combat` is **not** a control-flow "turn terminal" (the FT loop only stops at the step cap / the close instruction — `ft-config.ts`). After it returns, the model is instructed (via the tool result + the existing final-step close instruction) to stop calling tools and close the turn; if it doesn't, the step cap bounds it. Both tools fire in one FT turn (interleaved: prose → `initiate_combat` → prose → `resolve_combat`); the step cap (`FT_MAX_TOOL_STEPS`) comfortably fits two combat calls, but the plan specifies the **recovery path** if `initiate` commits without a matching `resolve` (the persisted `CombatState.status='resolving'` is detected and the next resume/turn force-resolves from the already-determined `outcome` — the outcome is decided at `initiate`, so no information is lost).

**Constraint-injection holds (D13):** the dice own the outcome *and its required cost envelope*; the FT owns the *telling* and the specifics *within* the envelope — it cannot narrate away the stakes.

---

## 3. Resume (just the mode flip)

The session sits in `combat` (status `resolved`) showing the result, with **normal turns gated off** (D14 — only `resume_combat` is accepted inbound). A player sends a `resume_combat` WS message (any member, D6):

1. **Claim the resume once** — `tryMarkResumed` SET-NX (D15, mirroring `tryMarkEnding`). Two simultaneous "okay"s → exactly one proceeds; the loser no-ops.
2. The winner: flip `mode → exploration` (merged write, §1); clear `session:{cId}:combat`; broadcast `mode_change(combat→exploration)`.
3. Exploration resumes; the next player turn proceeds normally with the aftermath in context.

**The ST + Scribe already ran** — the `initiate`+`resolve` turn went through the worker's normal post-turn tail (`turn-worker.ts` enqueues ST-eval + Scribe after `persistTurn`), so the combat was processed **once, at turn-end** (D10). FT continuity is automatic (the narration is in `ft_history`); the ledger was applied at resolve; the `CombatSummary` is on the (now-cleared-into-the-next-turn-context) record. **There is no separate ST/Scribe enqueue at resume** — doing so would double-extract facts. Resume is purely the mode flip + a control action, producing no new prose by itself (the resolution narration already told the fight).

> Why ST-eval-at-turn-end is acceptable even though it runs *before* the player resumes: the ST eval is post-hoc context for the *next* turn, which can't fire until resume re-opens the inbound path (D14). So the ordering is fine.

---

## 4. The outcome model — Principle #5 applied to combat

`resolveCombat` mirrors `resolveSkillCheck`'s shape (Haiku table → deterministic roll → matched tier → constraint), with four tiers instead of three.

**Tiers + thresholds.** The roll is `total = partyCapability + d20`, compared to the Haiku-supplied `DC`. Four tiers need three thresholds:

| Tier | Condition | `CombatOutcome` (§5) | Cost envelope (D13) |
|------|-----------|---------------------|---------------------|
| `decisive` | `total ≥ DC + 7` | `victory` | no PC casualties; minor/no HP loss |
| `costly` | `DC ≤ total < DC + 7` | `victory` | aggregate PC HP loss ≥ ~30% of party max; no PC drops |
| `pyrrhic` | `DC − 7 ≤ total < DC` | `victory` | ≥1 PC reduced to 0 HP (downed); the party still prevails |
| `routed` | `total < DC − 7` | `defeat` | the party does **not** win; recoverable (flee/capture/downed), PC death only here and only if the FT's narration + the worst-case envelope warrant it |

This is **win-skewed by construction** (three of four tiers are wins) — *intended*: PCs picking a fight they triggered should usually win, but with real, dice-determined cost. The skew is bounded by `partyCapability` (a weak party vs a high DC reaches `routed`/`pyrrhic`; a strong party vs a low DC reaches `decisive`).

**`partyCapability` (the balance knob — bounded so the d20 still matters).** A mechanical function of the party, **not** a raw sum (which would swamp the ±19 d20 swing and make the roll cosmetic). Define it as `clamp( round(avg(PC level) ) + partySizeBonus, 0, 12 )` where `partySizeBonus` is small (e.g. `+0/+1/+2` for 1–2 / 3–4 / 5+ PCs) and a low-HP party takes a malus (e.g. `−2` if the party's current HP is < 50% of max — wounded parties fight worse). Range ~0–12, matched against a Haiku `DC` in the skill-check band (~8–22). So `total` ∈ roughly `[1, 53]` and a mid party (`cap≈6`) vs a mid DC (≈15) lands across all four tiers as the d20 swings — the roll is decisive, not cosmetic. The plan pins the exact formula + a worked example per tier; `calculateModifier` (skill-check) is the precedent for a bounded, auditable capability term.

**Table.** A Haiku call (the skill-check model tier, `abortSignal` forwarded) gets the enemies (FT-declared, public) + the **public party snapshot** (levels/current+max HP only — the rendered ledger projection, never the full character row, §6) and returns `{ dc, outcomes: { decisive, costly, pyrrhic, routed } }` (four prose outcomes + the DC). **Fail-soft:** on any Haiku failure → a fallback table with a fixed mid `DC` (≈15, the combat analogue of `FALLBACK_DC`, homed in `ft-config.ts`) + four generic-but-distinct fallback outcome strings, so the deterministic roll still selects a meaningful tier (Principle #5's "roll then match" holds).

**Safety (D9).** PC death is reachable only in `routed` and is never automatic — the envelope's worst case is "downed/captured," and death requires the FT's narration to call for it within that envelope. No tier produces a blanket TPK.

The selected tier's prose + its cost envelope are returned at `initiate_combat`'s `execute`; `resolve_combat` reports deltas, which the resolver **reconciles against the envelope** (D13) before applying.

---

## 5. `CombatSummary` (lean L1)

A subset of the §11 structure — the L1-meaningful fields, assembled deterministically (no LLM call):

```ts
interface CombatSummaryL1 {
  outcome: 'victory' | 'defeat' | 'flee' | 'other'   // derived from the tier
  outcomeDescription: string                          // the tier prose / resolve narration
  casualties: Array<{ name: string; type: 'pc' | 'npc'; fate: 'dead' | 'unconscious' | 'fled' | 'captured' }>
  hpChanges: Array<{ combatant: string; hpBefore: number; hpAfter: number; maxHp: number }> // PCs (from the ledger)
  conditionsRemaining: Array<{ combatant: string; condition: string }>
  loot: Array<{ source: string; items: string[] }>    // FT-described, if any
}
```

(§11's `roundsElapsed`, `dramaticMoments`, `resourcesExpended` are turn-/rules-engine concepts → deferred to L2.)

---

## 6. Enforced ignorance

Combat is **player-facing prose by construction**: the FT authors the narration and narrates openly; the outcome table sees only the FT-declared enemies (public) + the party's mechanical ledger state (HP/levels — not secrets). There is no plot/secret input to the combat path and no tier filter to misconfigure. The combat narration joins the transcript as `dm_text` — public, like all FT prose (consistent with the 74d corpus posture). The Haiku table prompt receives no `sd_playbook` / secret content.

---

## 7. Testing

- **Real-PG + real-LLM smoke (the seam):** an FT turn that triggers combat → assert `mode_change(→combat)` + `combat_started` broadcast, `session:{cId}:combat` written at persist, the reconciled ledger HP delta applied, `combat_resolved` broadcast, the turn persists clean (a `dm_text` narration row **plus** the two registered combat-kind rows — proving the codec registration, D11), and the worker's normal ST-eval + Scribe **did fire once at turn-end** (D10); then drive `resume_combat` → assert `mode_change(→exploration)`, `CombatState` cleared, and **no second ST/Scribe enqueue**. (Wire level: WS + SSE + psql, not browser automation.)
- **Constructed smoke (the defeat path + envelope enforcement):** force a `routed`/`pyrrhic` tier (stub the roll or seed a weak party / strong enemies) and assert recoverable-defeat handling + a PC-drop ledger write. **Adversarial envelope test:** feed `resolve_combat` deltas that *contradict* the tier (tier `pyrrhic`, FT reports no casualties / trivial damage) and assert the resolver **clamps to the envelope** (D13) — the dice-owned stakes survive an underplaying FT.
- **Unit (pure):** tier selection (roll vs DC → tier across all four thresholds), `partyCapability` (bounded range + the wounded malus + party-size bonus), the fail-soft fallback table, the deterministic `CombatSummaryL1` assembly, the casualties PC/enemy partition + the PC-`dead` representation.
- **Concurrency:** two simultaneous `resume_combat` → exactly one mode flip + one `:combat` clear (the SET-NX interlock, D15); a normal `player_message` arriving in `combat` mode is **dropped/queued**, not turned into a phantom turn (D14); a reconnect mid-combat surfaces the result from `:combat` (D15), not a blank screen; a session suspended mid-fight keeps `:combat` alive via `refreshTtls`.
- **Leak/scoping:** no `sd_playbook`/secret content reaches the Haiku outcome-table prompt; the party snapshot is the public projection (HP/level only); combat narration carries no secret marker (mirrors the 74d correction-row invariant).
- **Contract/codec:** the transcript-codec test round-trips the two new combat kinds (assistant→rows→assistant); `session-events` contract tests cover the new client/server frames; the dev-tool route/registry stays consistent.
- **Dev-tool:** a combat panel (or session-panel extension) rendering the mode flips + `combat_started`/`combat_resolved` events with a "resume" button — the stand-in for the player combat screen.

**No migration is required** — the codec registration (D11) is a TS-only change (`message_type` is free TEXT, migration 024); the `CombatState` is Redis-only. Only the transcript-codec test updates.

---

## 8. Implementation seams (the contract + concurrency ripple)

The blind review established that combat is **not** absorbed "for free" by the existing turn loop. A faithful implementation touches these surfaces — the plan tasks each:

- **Transcript codec** (D11, TS-only, no migration): `DM_MESSAGE_TYPES` / `TOOL_TO_KIND` / `KIND_TO_TOOL` (`transcript-codec.ts`) gain `combat_initiate` / `combat_resolve` (kind === tool name); the codec test updates. (`message_type` is free TEXT — no CHECK, no migration.)
- **Frame emission seam** (§1): a `TurnEmitter` method + `TurnPublisher.emitFor` branch + `emitFrameForResult` branch (`fast-thinker.ts`) + `ServerFrame`/`SERVER_FRAME_TYPES` entries (`contract/session-events.ts`) for `mode_change` / `combat_started` / `combat_resolved`.
- **Inbound `resume_combat`** (§3, D14/D15): `CLIENT_FRAME_TYPES` + the `ClientFrame` union + `classifyClientFrame`/`parseClientFrame` + the `handleInbound` branch (`ws-session.ts`, `session-events.ts`); plus the `mode === 'combat'` inbound drop-gate (D14) alongside the existing `isEnding` gate.
- **Session state** (§1, D12/D15): the `:combat` key + a merged (CAS / sequenced) `mode` write at persist; `:combat` added to `refreshTtls`; `tryMarkResumed` SET-NX; the reconnect/replay path reads `:combat` and emits a synthetic combat frame.
- **The combat tools + resolver** (§2, §4): `ft-tools.ts` `initiate_combat`/`resolve_combat` (pure `execute`); a `resolveCombat` resolver mirroring `skill-check.ts` (Haiku table + roll + tier + envelope + fail-soft); the envelope reconciler (D13); the casualties partition + PC-`dead` ledger write (`rules-lawyer-vitals.ts`).
- **Worker wiring** (§2, §3, D10): the consume-loop emits the frames; persist writes mode + `CombatState`; the existing post-turn ST/Scribe tail processes the combat once (no resume-time enqueue); the `status='resolving'`-without-`resolve` recovery path.
- **Dev-tool**: a combat panel (or session-panel extension) + its registry/coverage entries.

---

## 9. Out of scope (→ combat mode / L2)

Round-by-round turns, player combat actions/inputs, initiative actually sequencing anything, enemy stat blocks, mechanical rules resolution (AC / damage / condition effects), the action stack + reactions, voxel maps, the React combat **screen** (Frontend milestone), and the human-typed "manual" resolution mode. MYT-75 proves the seam, the mode machinery, and a real-stakes single-shot resolver — the scaffolding the real combat mode grows into.
