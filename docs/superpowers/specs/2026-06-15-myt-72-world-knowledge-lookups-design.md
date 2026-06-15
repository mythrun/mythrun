# MYT-72 — World-knowledge lookups (unified ST-gated flow) — Design

> **Status:** Approved at the brainstorm gate (2026-06-15). Spec → blind review → plan → beads → implementation.
> **Linear:** MYT-72 · **Milestone:** Session Runtime + Combat L1
> **Spec sources:** Multiplayer Session Runtime §17.4–§17.8; MYT-69 SlowThinker design §4; MYT-71 world-store retrieval (shipped).

## 1. Goal & scope

The Fast Thinker (FT) can pull world knowledge it lacks — from the Postgres world store shipped in MYT-71 — **without ever seeing secrets**. A player asks about world state the FT can't answer from its curated `ft_context`; a skill check gates the lookup; a resolver over-pulls the store across *all* tiers; the **Slow Thinker (ST)** is the single safety gate that vets what (if anything) to surface and relays it back into the in-flight turn. On a genuine gap, the ST **invents** a tone-consistent answer (the play-is-canon loop). The FT never knows an ST was in the loop — it only sees the relay as a `tool_result`.

**Done when** (from the issue): a passed lookup returns ST-vetted info to the FT; a secret-touching query never leaks; a miss yields an ST invention.

### 1.1 Scope decisions (resolved at brainstorm)

- **D1 — Relay-only; no durable writes.** MYT-72 is the lookup → ST-vet → relay → FT flow + invent-on-miss, informing **this turn only**. It writes nothing durable. The invented/relayed fact carries forward via the FT's own transcript (the FT holds the full session transcript). All canonization — the §17.7 ephemeral working set *and* the end-of-session match-vs-mint reconcile — is **MYT-73 (Scribe)**. This also removes the §17.8 "NPC-claim vs objective-canon *write* semantics" question from MYT-72's plate (nothing is written).
- **D2 — Both §17.5 channels (Ask-the-DM + Ask-an-NPC).** Shared spine (check → resolver → ST-vet → relay); the NPC channel adds stat fabrication, an ST-vet framing difference, and a roll-hidden UX.
- **D3 — A family of per-substrate tools** (not one parameterized tool). Three tools matching the MYT-71 substrates, each carrying a `channel` discriminator. Tight per-tool arg schemas; avoids the discriminated-union-at-root shape Anthropic rejects (ft-tools.ts:103–113).
- **D4 — The ST-vet is a new synchronous Opus call** inside the tool's `execute` (§17.4: "Opus, mid-turn, every lookup"). It does **not** reuse the async `st-evaluation` BullMQ worker (which has no return channel and a ~2.5 min latency budget — st-config.ts `ST_EVAL_TIMEOUT_MS=120_000`). It is modeled on the existing `st-gate.ts` / `st-director.ts` `generateObject`+repair wrapper pattern. This is one member of the §17.8 "family of privileged Opus calls" (the `lookup-vet-and-relay` call); decomposing the ST is settled here for this slice only.
- **D5 — The skill-gate DC is contextual** (§4.1): set by topic obscurity *relative to the asker's standing/knowledge of the subject*, with a genuine **no-roll auto-success** when knowledge is a foregone conclusion (the PC heading the org being asked about) and a **very high DC** when knowledge is implausible (a 4-year-old on city governance). The "would they even know?" call is Haiku's.

### 1.2 Non-goals / deferred

- **No durable writes / canonization** → MYT-73 (Scribe).
- **No spatial `locations_near` substrate** → MYT-78 (MYT-71 shipped lore + the two graph walks; spatial was cut from MYT-71).
- **No text-to-SQL escape hatch** (§17.6) → cut from MYT-71/the substrate line; not reintroduced here.
- **No independent Haiku leak-check** (§17.4): the ST is the single gate; the relay text is its sanctioned output. An optional output form-checker is explicitly *held in reserve*, not built.

## 2. Architecture — the deterministic flow inside each tool

Each `world_fact_lookup` family tool's `execute` runs this sequence and returns **only the ST's relay** as the `tool_result` (§17.4 — the FT does not know an ST ran):

```
player asks → FT emits a lookup tool call
  └─ execute():
       1. SKILL-GATE (channel-dependent)         fail → return the "blank" (FT narrates not-knowing); cost skipped (§17.5)
       2. RESOLVE   (MYT-71, over-pull ALL tiers, secrets included — find what's RELEVANT not SAFE, §17.6)
       3. ST-VET-AND-RELAY  (new sync Opus call: results+tiers + sd_playbook + tone → relay | none | invent)
       4. RETURN the relay text as tool_result   → FT narrates from it (no ST visible)
```

Mechanically this fits the FT's interleaved tool loop (fast-thinker.ts:504–552): the tool returns data, the SDK feeds it back as a `tool-result` for the FT's next step, the FT narrates. The lookup itself emits **no player-visible frame** (the relay flows into prose); the **skill-gate** emits the existing skill-check frame (an NPC-channel variant hides the roll). No new `TurnEmitter` method is required for the lookup data path.

## 3. The tool family (`buildFtTools`, ft-tools.ts:182)

Three tools, registered by adding entries to the returned `ToolSet`. Each `inputSchema` is a flat `z.object` (root `"type":"object"`). All carry the `channel` discriminator.

| Tool | Substrate (MYT-71) | Args (beyond channel) |
|---|---|---|
| `search_lore` | `searchLore(worldId, topic, {limit})` (semantic, total → `[]`) | `topic: string` |
| `characters_known_to` | `charactersKnownTo(deps, entityId, {nameFilter?, maxDepth?})` | `character: string`, `name?: string` |
| `faction_tree` | `factionTree(deps, entityId)` | `faction: string` |

**Channel discriminator** (every tool):
- `channel: 'dm' | 'npc'`.
- DM channel adds `skill: <Knowledge skill>` — the FT's reasoning picks the relevant PC skill (History/Arcana/Religion/Nature/Investigation; the canonical map is in skill-check.ts:30–31). ZFC: routing (which tool, which skill, which channel) is the FT's job; execution is deterministic.
- NPC channel adds `npc_name: string` — the character being asked.

**Entity-name → id resolution.** `characters_known_to`/`faction_tree` take a *name* from the FT (it reasons in names), resolved to an `entityId` via the existing scoped character/entity projection before the graph call. A name that resolves to nothing is a clean "no such character" relay (not an error).

## 4. The skill-gate (extends the skill-check pattern, skill-check.ts:76)

The gate is rolled **before** the resolver so a failed check skips the lookup cost (§17.5). It reuses the deterministic roll-vs-DC + tier-match core and the TOTAL contract (`{ok:true, payload}` / `{ok:false, errorConstraint}`, never throws), but with a **contextual** DC-table generation (below) richer than the bare topic-obscurity `fetchDcTable`.

### 4.1 The DC is contextual, not topic-absolute (load-bearing)

The DC — and *whether a roll happens at all* — is set by the topic's obscurity **relative to the asker's plausible access to it**: their role, standing, relationship to the subject, and competence — not topic difficulty in the abstract. Two extremes the gate must handle explicitly:

- **Auto-success — no roll.** When the asker would *obviously* know the answer, the gate **auto-passes without rolling** → straight to resolve → ST-vet → relay. Example: the PC is the head of the secret organization the question is about; an NPC asked about their own household. The DC-table generation returns a `{ auto: 'success' }` verdict (no dice, no skill-check frame for the roll — at most a "you know this" beat).
- **Implausible knowledge — very high DC (likely fail).** When the asker plausibly *couldn't* know, the DC is set very high — they *can* roll but probably fail. Example: a 4-year-old NPC asked about city governance; a foreign PC on a closely-held local secret.
- The continuum between is the normal case (DC scales with plausibility).

This makes the lookup gate a **contextual skill check**: the Haiku DC-table generation (the established pre-roll pattern, ZFC-delegated) is given the **asker's standing** alongside the topic, and returns either `{ auto: 'success' }` or `{ dc, outcomes }` with the DC scaled by plausibility. The "would they even know this?" judgment is Haiku's, not hardcoded.

> **Rationale — contextual DC.** A flat topic-obscurity DC produces absurd outcomes (the guild master failing to recall their own guild's structure; a toddler acing a governance question on a lucky d20). The asker's relationship to the subject is the dominant variable, so the gate must factor it in — including skipping the roll when knowledge is a foregone conclusion.

### 4.2 The two channels

- **DM channel** — the asker is the **PC**. The contextual DC-table is given the PC's chosen Knowledge `skill` *and* the PC's role/background/standing (from `ft_context` / the character sheet) so the auto-success and high-DC ends fire correctly. Auto-success → relay directly; else roll the skill vs the contextual DC. Pass → resolve; fail → the blank (the `errorConstraint` the FT narrates around). Emits the existing skill-check frame (suppressed on auto-success).
- **NPC channel** — the asker is the **NPC**. The contextual DC-table is given the NPC's identity/standing/playbook. If the NPC entity has a stat block, use its scores; if not, **fabricate** plausible ones on the fly (acceptable per §17.5). The player is shown **pass/fail only, no roll** — a distinct frame variant. Pass → resolve; fail → the NPC "doesn't know" relay. (Auto-success applies symmetrically — the org's own spymaster asked about the org doesn't roll.)

> **Rationale — fabricate-don't-block.** An NPC without a stat block is the common case early in a campaign; blocking the lookup on a missing stat block would make the NPC channel feel broken. A one-off Haiku-fabricated check keeps the fiction moving; durable NPC stats are a Scribe/prep concern, not a lookup blocker.

## 5. The ST-vet-and-relay call (the one greenfield piece)

A new synchronous Opus call: `llm/st-lookup-vet.ts` (or `session/` ST family), modeled on `st-gate.ts` — a `generateObject` + repair-fallback wrapper with a template prompt file (LLM prompts are template files, not inline strings).

- **Input:** the player's query/intent; the channel (+ the NPC's identity & playbook-bounded knowledge for the NPC framing); the **over-pulled results with their `access_level` tiers** (`LoreHit.accessLevel` is already on every result, types.ts:28); the **secret `sd_playbook`** (so the ST can judge safety and invent tone-consistently); the world tone.
- **Output:** `{ mode: 'relay' | 'none' | 'invent', text: string }`.
  - `relay` — a found, tier-safe answer surfaced from the results.
  - `none` — genuine emptiness arbitrated by the ST (§17.6 "empty ≠ invent"); the FT narrates a real "nothing found."
  - `invent` — a real gap; a tone/thread-consistent fabrication (play-is-canon, §17.4 step 5).
- **It is the single tier-safety gate.** There is no `access_level` filter on the resolver to misconfigure (§17.6 "no tier-filtering on the resolver"). The ST is *allowed* secrets; it decides what is safe.
- **Channel framing:** DM → objective world truth; NPC → "what this NPC would convey," bounded by the NPC's playbook knowledge, partial/wrong allowed (§17.5).
- **Latency:** a mid-turn Opus call is a deliberate, accepted tax (§17.4 cost note) — lookups are skill-gated and rare. Its own timeout is the FT-turn-appropriate budget, **not** the 2-min async `ST_EVAL_TIMEOUT_MS`.

## 6. Wiring + enforced ignorance

- **Construction:** `makeTiers` (turn-worker.ts:566–588) builds a Voyage embedder + `createSearchResolvers({embedder, repo, logger})` + the graph deps (`{repo}`) + the ST-vet, and widens `FtToolDeps` (ft-tools.ts:168–172) to carry: the search resolvers, the graph deps, `worldId`, the entity/character name→id projection, and a **new secret-bearing `sd_playbook` read** (FT-side process only — see below).
- **The boundary (the line that matters most).** The secret inputs (over-pulled secret-tier facts + `sd_playbook`) are read and processed **inside the tool's `execute`** for the ST-vet, and **only the relay text** is returned to the FT model. The FT's `FtTurnContext` (tiers/types.ts:113–137) is untouched — still public-by-construction. This is exactly §17.4's design ("the resolver runs search→ST internally and returns the ST's relay as the tool_result").
  - This **does** introduce the first secret-bearing read into the FT-side turn-worker *process* (today only the async ST worker reads `sd_playbook`, st-evaluation-worker.ts:65–67). That is endorsed by §17.4 and is safe because the secret never reaches the **FT model call** — the non-negotiable boundary ("plot info to a Fast Thinker *call* is a bug") is about the model's inputs, which remain the vetted relay only.
- **Leak invariant (tested):** no secret-tier content ever appears in a `tool_result`. The ST-vet is the only thing that touches secrets and it returns only `text`; the tool returns only that `text`.

## 7. Error handling — every tool is TOTAL (fail-soft; never throws into the FT)

Tools are pure resolvers returning data only (ft-tools.ts:6–22); an `{error}`-style fail-soft channel is what the FT narrates around. For the lookup family, fail-soft is stricter — a failure must **never** surface an unvetted result or a raw error:

- skill-gate fail → the blank (channel-appropriate).
- `searchLore` is already total (throws → `[]`).
- graph walks throw on DB error → caught here (graph.ts:11–13 names "MYT-72's tool-error handling" as the catch site) → treated as empty → ST-vet arbitrates none-vs-invent.
- **ST-vet failure** (Opus error/timeout/repair-exhausted) → a fail-soft relay ("you can't quite recall" / "they don't seem to know"). **Never** a raw error, **never** an unvetted/over-pulled result leaking through. This is the load-bearing fail-soft arm.
- embed (query-embedding) failure inside `searchLore` is already swallowed to `[]` by MYT-71.

## 8. Relay-only — no writes (D1, restated for the implementer)

The ST's relay/invention informs **this turn's prose only**. MYT-72 calls no write primitive. Continuity within the session is the FT's transcript (it remembers what it narrated). Durable canon — the §17.7 working set and the end-of-session match-vs-mint reconcile + re-embed — is entirely MYT-73. Accepted v1 limit: a fact invented in turn 5 is not in the *store* for a fresh lookup in turn 6 (rare; lookups are gated and infrequent, and the FT carries the narrated fact).

## 9. Testing

- **Per-tool unit tests** (mocked resolver + mocked ST-vet): each of the three tools routes args correctly, gates, and returns the relay.
- **Enforced-ignorance leak test (load-bearing):** seed a `secret`-tier fact relevant to a query; assert it is over-pulled by the resolver, reaches the ST-vet, and **never** appears in the `tool_result`.
- **Skill-gate matrix:** DM pass/fail → resolve/blank; NPC pass/fail with a stat block and with fabrication; NPC frame hides the roll.
- **Miss → invent:** empty resolver result with a real gap → ST-vet `mode:'invent'`; genuine emptiness → `mode:'none'`.
- **Fail-soft:** ST-vet error → fail-soft relay, never a raw error or unvetted leak.
- **Gated constructed smoke (real LLM, per the dev-tool-E2E rule):** seed a world with both public and secret facts on a topic; drive a real `search_lore` (DM channel) through the real resolver + the **real Opus ST-vet**; assert the relay surfaces the public fact and **never** the secret string. A second pass drives the NPC channel and the invent-on-miss path.

## 10. Interface contracts (new surface)

- `llm/st-lookup-vet.ts`: `runStLookupVet(deps, input): Promise<{ mode: 'relay'|'none'|'invent', text: string }>` — `generateObject`+repair, template prompt, Opus. Input type carries the query, channel context, tiered results, `sd_playbook` slice, tone.
- `session/tiers/ft-tools.ts`: three new tool entries in `buildFtTools`; `FtToolDeps` widened with the retrieval resolvers + graph deps + `worldId` + the name→id projection + the secret `sd_playbook` read + the ST-vet.
- A **contextual skill-gate** `session/world-lookup-gate.ts`: a richer DC-table generation (asker's standing + topic → `{ auto: 'success' }` | `{ dc, outcomes }`, §4.1) plus the reused deterministic roll-vs-DC core; handles both channels (DM = PC skill + standing; NPC = stat-or-fabricate) and the auto-success no-roll path. Keeps the three tools DRY.
- A shared `session/world-fact-lookup.ts` orchestrator (gate → resolve → ST-vet → relay) the three tools call with their substrate closure — keeps each tool entry thin.

## 11. Open questions (small; resolve in plan)

- **Where the ST-vet module lives** (`llm/` next to the other ST wrappers vs `session/`): the other ST calls (`st-gate.ts`, `st-director.ts`) live in `session/` — follow that.
- **NPC playbook-knowledge slice:** the ST already reads `sd_playbook`; confirm it carries enough per-NPC knowledge framing, or pass the NPC's prose-kernel/facts alongside. (Resolver-fetchable; not a blocker.)

## 12. References

- Multiplayer Session Runtime spec §17.4 (unified ST-gated retrieval), §17.5 (two channels), §17.6 (resolver mechanism, no-tier-filter, empty≠invent), §17.7 (write-authority map — Class 2 is MYT-73), §17.8 (open: ST job scope).
- MYT-69 SlowThinker design §4 (the §8.2 direction-channel bound the relay widens).
- MYT-71 world-store retrieval (the resolver barrel `world/retrieval/index.ts`; `LoreHit.accessLevel` tiering).
- Code: `session/tiers/ft-tools.ts`, `fast-thinker.ts`, `skill-check.ts`, `st-gate.ts`/`st-director.ts`, `st-evaluation-worker.ts`, `turn-worker.ts` (`makeTiers`), `tiers/types.ts`.
