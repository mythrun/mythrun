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

This makes the lookup gate a **contextual skill check**: the Haiku DC-table generation (the established pre-roll pattern, ZFC-delegated) is given the **asker's PUBLIC standing** (role/background/known facts from `ft_context` / the character sheet — never the secret playbook) alongside the topic, and returns a verdict scaled by plausibility.

- **Schema (flat — no root discriminated union, which Anthropic's structured-output rejects, cf. ft-tools.ts:103–113):** `{ auto_success: boolean, dc: number (1..30), outcomes: { fail, success, great_success } }`. When `auto_success` is true the `dc`/`outcomes` are ignored by code (mirrors how the ledger tools flatten a discriminated input + branch in the resolver). Auto-success **bypasses the d20 + tier-match entirely** — it is not a DC-1 roll.
- **Public-standing only here; the secret-aware override is the ST-vet's (§5).** The Haiku gate cannot see secret standing, so a PC who *secretly* heads the org would look like a stranger to it. The secret-aware auto-success/high-DC adjustment therefore lives in the ST-vet (which holds `sd_playbook`), not here. The Haiku gate handles the *public* foregone-conclusion (and the public-implausible high DC); the ST-vet handles the *secret-backed* ones.

> **Rationale — contextual DC + passive-check framing.** A flat topic-obscurity DC produces absurd outcomes (the guild master failing to recall their own guild's structure; a toddler acing a governance question on a lucky d20). The asker's relationship to the subject is the dominant variable. The *public* auto-success is mechanically a 5e **passive check** (take-10: `10 + modifier ≥ DC` ⇒ no roll), which is deterministic arithmetic the code already has (`skill-check.ts:111`) — the Haiku gate's `auto_success` should align with that floor rather than fight it, reserving Haiku's judgment for the standing-relative DC. The *secret*-backed foregone conclusion can't be arithmetic (the deciding fact is hidden), so it is the ST-vet's call.

### 4.2 The two channels

- **DM channel** — the asker is the **PC**. The `skill` arg is **constrained to a Knowledge-skill enum** (`history | arcana | religion | nature | investigation`, plus `medicine | survival | insight` for domain queries) so a free-form FT pick can't silently become an `Unknown skill` hard blank (skill-check.ts:80–84). The contextual DC-table is given that skill + the PC's *public* role/background. Auto-success → relay directly; else roll the skill vs the contextual DC. Pass → resolve; fail → the blank (the `errorConstraint` the FT narrates around). Emits the existing skill-check frame (suppressed on auto-success — at most a "you know this" beat).
- **NPC channel** — the asker is the **NPC**. The contextual DC-table is given the NPC's *public* identity/standing. If the NPC entity has a stat block, use its scores; if not, **fabricate** plausible ones on the fly — **seeded off the NPC's `entityId`** so the same statless NPC gets stable scores across lookups in a session (no durable write needed; D1). The player is shown **pass/fail only, never the roll**.
  - **No metagame tell (corrects the auto-success interaction):** the NPC channel must render **identically** whether the result came from auto-success or a hidden successful roll — the player can never distinguish "this NPC obviously knew" from "this NPC rolled and passed," because a visible instant-vs-rolled difference would leak the NPC's hidden standing (a spymaster's auto-success on their own org is itself a tell). Pass → resolve; fail → the NPC "doesn't know" relay.

> **Rationale — fabricate-don't-block.** An NPC without a stat block is the common case early in a campaign; blocking the lookup on a missing stat block would make the NPC channel feel broken. A one-off Haiku-fabricated check keeps the fiction moving; durable NPC stats are a Scribe/prep concern, not a lookup blocker.

## 5. The ST-vet-and-relay call (the one greenfield piece)

A new synchronous Opus call: `llm/st-lookup-vet.ts` (next to the sibling ST wrappers — `st-gate.ts`/`st-director.ts` live in `llm/`, **not** `session/`), a `generateObject` + repair-fallback wrapper with a template prompt file (LLM prompts are template files, not inline strings).

- **Input:** the **player's question as the FT framed it** + a **slice of recent narrative context** (the FT's recent exchanges, analogous to `st-director`'s `recentExchanges`) — so `invent` mode can be *thread*-consistent, not just tone-consistent, and so the gate sees what was already said this session; the channel (+ the NPC's identity & playbook-bounded knowledge for the NPC framing); the **over-pulled results, each annotated with its `access_level` tier** (see §5.1 — for graph substrates the tier must be *joined on*, it is not on the raw graph rows); the **secret `sd_playbook`**; the world tone.
- **Output (flat object, no root union):** `{ mode: 'relay' | 'none' | 'invent', text: string, tier: AccessLevel }` where `text` is `z.string().min(1)` with **no `.max()`** (free prose — see `feedback_no_max_on_llm_prose_fields`), and `tier` is the ST's tier tag for the relayed/invented content (provenance MYT-73's Scribe needs when it canonizes the working set; emitted now, consumed later).
  - `relay` — a found, tier-safe answer surfaced from the results.
  - `none` — genuine emptiness arbitrated by the ST (§17.6 "empty ≠ invent"); the FT narrates a real "nothing found."
  - `invent` — a real gap; a tone/thread-consistent fabrication (play-is-canon, §17.4 step 5).
- **It is the single tier-safety gate.** The ST is *allowed* secrets; it decides what is safe. It gates using both the per-result tier annotation **and** its own `sd_playbook` knowledge.
- **Repair posture (load-bearing — corrects the `st-gate` analogy).** The relay `text` is surfaced *verbatim to the player*, so it is authoritative prose like `st-director`'s `direction`, **not** code-consumed like `st-gate`'s output. A JSON repair re-authors that prose with a *different* model — which would defeat "the ST is the single gate." Therefore: surface `repairAttempted` from `runStLookupVet` and treat a repaired result as a **fail-soft** (route to the §7 generic relay), exactly as `st-director` discards a repaired direction. Never surface repair-authored relay text.
- **Secret-leak suppression (corrects the `tool_result`-only invariant).** This is the one Mythrun LLM call whose *raw output* reasons over secrets. The `ai.ts` repair machinery captures `rawTextSnippet` (first 2048 chars of raw output) into structured logs + `pipeline_runs.error` + a stage-failed SSE event — built for world-gen, where output is non-secret. `runStLookupVet` MUST route through a variant that **suppresses/redacts `rawTextSnippet`** so a malformed-JSON ST-vet response cannot spill a secret into logs or an error frame. (§9 tests this.)
- **Channel framing:** DM → objective world truth; NPC → "what this NPC would convey," bounded by the NPC's playbook knowledge, partial/wrong allowed (§17.5).
- **The secret-aware standing override (the auto-success/high-DC poles, §4.1).** The pre-roll Haiku gate sees only *public* standing (`ft_context`), so it cannot judge auto-success for a *secret-backed* role (a PC who **secretly** heads the org would look like a stranger → high DC → fails to recall their own org — the inversion of the headline example). So the **secret-aware standing override lives here**, in the ST-vet (which holds `sd_playbook`): the Haiku gate handles public-standing obscurity; the ST-vet may upgrade a result to a confident relay (or recognize the asker obviously knows) using the secret standing. §4.1's auto-success is therefore two-sided: a *public* foregone conclusion is the Haiku gate's no-roll; a *secret* one is the ST-vet's call.
- **Latency:** a mid-turn Opus call is a deliberate, accepted tax (§17.4 cost note) — lookups are skill-gated and rare; the cost is a *full-`sd_playbook` Opus call per lookup* (uncached, materially pricier than the Haiku gate it sits behind). Its own timeout is an explicit `ST_LOOKUP_VET_TIMEOUT_MS` pinned **well under** the remaining FT turn budget (`FT_TURN_TIMEOUT_MS = 180_000`), so the vet's own timeout → §7 fail-soft fires *before* the FT-turn abort would terminal-fail the turn. **Not** the 2-min async `ST_EVAL_TIMEOUT_MS`.

### 5.1 Graph results must be tier-annotated (closes the central leak)

`LoreHit.accessLevel` exists for `search_lore`, but `KnownCharacter`/`FactionNode` (the `characters_known_to`/`faction_tree` results) carry **no** `access_level` — the binder dropped it. A `faction_tree` over a public faction whose subtree contains a `secret`-tier node hands the ST untagged secret entities; the gate then leans entirely on `sd_playbook` cross-referencing, which is error-prone. **Fix:** the graph resolvers (MYT-71 surface) or a MYT-72-side enrichment must **join `access_level` onto every returned node** (the `entities` rows have it, migration 014), and the ST-vet input must carry per-node `accessLevel`. This is a small additive change to the `world-retrieval` binder's two graph queries + the result types. The §9 leak test must exercise the *graph* path, not only `search_lore`.

## 6. Wiring + enforced ignorance

- **The embedder is constructed once at boot, not per turn.** `worker.ts` already builds + boot-probes a `VoyageEmbedder` (for `probeVoyageAtBoot`); pass *that* probed instance into `buildSessionTurnWorker` (today it takes `(redisBatch, redisRealtime, redisKeyPrefix, logger, pool)` — add the embedder + `voyageApiKey`), and close over it in `makeTiers` so `createSearchResolvers({embedder, repo, logger})` is built per turn over a shared, already-probed embedder. (Constructing per-turn is wasteful and un-probed — a bad key would silently degrade every lookup to `searchLore → []`, the silent-failure mode.)
- **`worldId` must be resolved into the turn path (it isn't today).** `worldId` is on neither the `:state` blob nor `TurnWorkerRepo`. Read it once on the fresh-run arm of `processTurnJob` via `repo.campaigns.getWorldId(campaignId)` (campaigns.ts:144), **cache it on the `:state` blob** alongside `ftContext`/`worldTone` (so it's not a per-turn round-trip), and thread it through `TierTurnArgs` → `FtToolDeps`.
- **The secret read does NOT widen the FT-side repo surface.** Add a *separate, narrowly-scoped* `sdPlaybook` read (its own repo method on a dedicated lookup-vet surface) — do **not** widen `TurnWorkerRepo.sessionPreps.getBy` (deliberately `{ftContext}`-only, the MYT-69 split). `FtToolDeps` carries an **opaque `vet` closure** (the ST-vet, with the `sdPlaybook` read captured inside it), **never the raw `sd_playbook` string**. So no secret value is ever in scope in `ft-tools.ts` / `fast-thinker.ts` themselves — the secret enters, is vetted, and dies inside the vet module. This keeps the MYT-69 guarantee *structural* (the type system says "no secret on the FT seam") rather than downgrading it to *behavioral* discipline.
  - The secret therefore exists transiently only inside the vet closure's call, never reaches the **FT model call** (the non-negotiable boundary: "plot info to a Fast Thinker *call* is a bug" is about the model's inputs, which remain the vetted relay only), and is endorsed by §17.4 ("the resolver runs search→ST internally and returns the ST's relay as the tool_result").
- **Leak invariant (tested — broader than `tool_result`).** No secret-tier content appears in **any** of: the `tool_result`, the structured logs / `pipeline_runs.error` / SSE error frames (the `ai.ts` `rawTextSnippet` channel — suppressed for the ST-vet per §5), the skill-gate frame the player sees, or the **persisted + replayed** transcript. The relay is *not* ephemeral: a `world_fact_lookup` `tool_result` is serialized into a DM row by the transcript codec and re-injected into the FT model history on every later turn (transcript-codec.ts) — so a single secret in a relay would persist and re-leak forever. The invariant is permanent, which is *why* §5/§5.1's gate must be airtight.
  - **Codec mapping (else turn persistence crashes).** The three new tool names are not in `TOOL_TO_KIND` (transcript-codec.ts:54–57) — `assistantToRows` throws `TranscriptCorruptError` on an unknown tool name. The plan must either add a `world_fact_lookup` DM message type + round-trip mapping (then the persisted relay IS durable public canon and must be provably secret-free — reinforcing the invariant) **or** deliberately strip lookup parts before persistence (then the FT's next-turn memory is its prose only — the §8 accepted limit). Pick one explicitly.

## 7. Error handling — every tool is TOTAL (fail-soft; never throws into the FT)

Tools are pure resolvers returning data only (ft-tools.ts:6–22); an `{error}`-style fail-soft channel is what the FT narrates around. For the lookup family, fail-soft is stricter — a failure must **never** surface an unvetted result or a raw error:

- skill-gate fail → the blank (channel-appropriate).
- `searchLore` is already total (throws → `[]`). **Degraded ≠ empty:** `searchLore` swallows an embed/query *failure* to `[]` identically to a genuine zero-row result, so an infra blip would masquerade as emptiness and push the ST toward a *confident invention* of canon. Surface a **`resolver_degraded` boolean** into the ST-vet input so degraded-empty biases toward `none`/fail-soft, never `invent`.
- graph walks throw on DB error → caught here (graph.ts:11–13 names "MYT-72's tool-error handling" as the catch site) → treated as degraded (not genuine empty) → ST-vet leans `none`/fail-soft. (Note `factionTree` returns `{nodes, truncated}` and `charactersKnownTo` returns `KnownCharacter[]` with `depth` — the ST-vet receives these shapes, tier-annotated per §5.1.)
- **ST-vet failure** (Opus error / its own `ST_LOOKUP_VET_TIMEOUT_MS` timeout / repair-attempted / repair-exhausted) → a fail-soft relay ("you can't quite recall" / "they don't seem to know"). **Never** a raw error, **never** an unvetted/over-pulled result, **never** repair-authored relay text (§5 repair posture). This is the load-bearing fail-soft arm.
- **Timeout ordering:** `ST_LOOKUP_VET_TIMEOUT_MS` must fire *before* the FT-turn abort (`FT_TURN_TIMEOUT_MS`, fast-thinker.ts:528) would convert a slow vet into a thrown turn-abort. The vet's timeout routes to the fail-soft relay above; the FT-turn abort routes to a terminal turn failure. The plan pins the budget arithmetic (Sonnet step + Haiku gate + resolver + Opus vet + Sonnet narration ≤ 180s) and confirms the `abortSignal` threaded into `execute` doesn't turn a vet timeout into a turn-abort.
- embed (query-embedding) failure inside `searchLore` is already swallowed to `[]` by MYT-71 (now surfaced via `resolver_degraded`, above).

## 8. Relay-only — no writes (D1, restated for the implementer)

The ST's relay/invention informs **this turn's prose only**. MYT-72 calls no write primitive. Continuity within the session is the FT's transcript (it remembers what it narrated), and — newly, per §5 — the ST-vet is given recent narrative context, so an invention is *thread*-consistent within the session's narration, not just tone-consistent.

Durable canon — the §17.7 working set (the read side that closes the read-after-write gap *and* lets a later lookup see an earlier invention) and the end-of-session match-vs-mint reconcile + re-embed — is entirely **MYT-73**.

**Accepted v1 limit (explicit, per the brainstorm gate D1, not buried):** because MYT-72 builds no working-set *read* side, two *separate* lookups on the same genuinely-empty gap can invent divergently (a fact invented in turn 5 is not in the *store* for a fresh lookup in turn 9), and a parallel-player lookup can't see another's invention. This is the §17.7 read-after-write gap the working set was designed to close. It is accepted here because lookups are skill-gated and rare (a repeat lookup on the *same* invented gap in one session is uncommon), the FT carries its own narrated fact, and MYT-73 closes it fully. A blind reviewer (game-design lens) flagged this as a contradiction risk; it is a conscious scope decision, surfaced — not drift.

## 9. Testing

- **Per-tool unit tests** (mocked resolver + mocked ST-vet): each of the three tools routes args correctly, gates, and returns the relay.
- **Enforced-ignorance leak-test MATRIX (load-bearing — must cover every egress, not just `search_lore`/`tool_result`):**
  - (a) seed a `secret`-tier **fact** relevant to a `search_lore` query → over-pulled, reaches the ST-vet, **never** in the `tool_result`.
  - (b) seed a `secret`-tier **entity** as a child node in a `faction_tree` (and a `characters_known_to`) subtree → its name reaches the (tier-annotated, §5.1) ST-vet input and **never** in the relay.
  - (c) force a **malformed ST-vet output** whose raw text contains a secret → assert the secret string appears in **no** captured log / diagnostic / `pipeline_runs.error` / SSE frame (the §5 `rawTextSnippet` suppression), and the tool fail-softs.
  - (d) **persistence round-trip:** a lookup turn → assert the persisted DM row + the replayed `tool_result` carry no secret (per §6 codec mapping).
- **Skill-gate matrix:** DM pass/fail → resolve/blank; DM auto-success (public foregone conclusion) → no roll; mis-picked non-knowledge skill → handled, not an `Unknown skill` blank; NPC pass/fail with a stat block and with `entityId`-seeded fabrication; **NPC renders identically for auto-success vs hidden-pass** (no metagame tell, §4.2).
- **Miss → invent vs none vs degraded:** empty result with a real gap → ST-vet `mode:'invent'`; genuine emptiness → `mode:'none'`; `resolver_degraded` empty → biases to `none`/fail-soft, **not** `invent`.
- **Repair → fail-soft:** a `repairAttempted` ST-vet result is discarded to the fail-soft relay (never surface repair-authored text); ST-vet timeout/error → fail-soft, never a raw error or unvetted leak.
- **Gated constructed smoke (real LLM, per the dev-tool-E2E rule):** seed a world with both public and secret facts/entities on a topic; drive a real `search_lore` **and** a real `faction_tree` (DM channel) through the real resolver + the **real Opus ST-vet**; assert the relay surfaces the public content and **never** the secret string. Exercise **all three modes against real Opus** — `relay` (hit), `none` (genuine empty), `invent` (real gap) — plus the NPC channel and the secret-aware auto-success (the PC who secretly heads the org).

## 10. Interface contracts (new surface)

- `llm/st-lookup-vet.ts` (next to `st-gate.ts`/`st-director.ts`, which live in `llm/`): `runStLookupVet(deps, input): Promise<{ mode, text, tier, repairAttempted }>` — `generateObject`+repair with `rawTextSnippet` **suppressed** (§5), template prompt, Opus, `ST_LOOKUP_VET_TIMEOUT_MS`. Output schema flat: `{ mode: 'relay'|'none'|'invent', text: z.string().min(1) /* no .max() */, tier: AccessLevel }`; caller treats `repairAttempted===true` as fail-soft. Input carries the FT-framed question + recent narrative slice + channel context + **tier-annotated** results + `resolver_degraded` + `sd_playbook` slice + tone.
- `session/world-lookup-gate.ts` (contextual skill-gate): a Haiku DC-table call over **public** standing → flat `{ auto_success, dc, outcomes }` (§4.1, no root union) + the reused deterministic roll core; DM (knowledge-skill-enum) and NPC (`entityId`-seeded stat-or-fabricate) channels; auto-success bypasses the roll.
- `session/world-fact-lookup.ts`: the shared orchestrator (gate → resolve → ST-vet → relay) the three tools call with their substrate closure; returns the relay + a skill-gate sub-payload for the frame (tools can't emit).
- `session/tiers/ft-tools.ts`: three new tool entries; `FtToolDeps` widened with the search resolvers + graph deps + `worldId` + the name→id resolver + **an opaque `vet` closure (NOT the raw `sd_playbook`)**.
- `fast-thinker.ts` consume loop: a new `emitFrameForResult` branch mapping the lookup result's skill-gate sub-payload to a skill-check frame; the **NPC roll-hidden variant** needs a payload/emitter shape omitting the roll fields — so §2's "no new emitter method" is **corrected** (a variant is needed).
- `world/retrieval/` (small MYT-71-surface addition): join `access_level` onto the `charactersKnownTo`/`factionTree` result rows + types (§5.1).
- `transcript-codec.ts`: a `world_fact_lookup` `TOOL_TO_KIND` entry + round-trip mapping, **or** an explicit strip-before-persist (§6).
- Boot/turn wiring: thread the boot-probed `VoyageEmbedder` + `voyageApiKey` into `buildSessionTurnWorker`; resolve + cache `worldId` on the `:state` blob (§6).
- The name→id resolver: a `worldId`-scoped exact/normalized-name entity read (new `repo.entities` method) **or** top-1 `findSimilarEntities` (already a dep), reconciled against the TOTAL contract.

## 11. Open questions (small; resolve in plan)

- **Name→id resolution fuzziness:** the FT reasons in colloquial/partial names ("the Spymaster"); exact-match yields a "no such character" that *feels* broken. Decide exact-match-and-accept (FT retries with a canonical name from `ft_context`) vs. top-1 `findSimilarEntities` (the ZFC-correct fuzzy matcher). Note: a secret entity absent from the public name→id surface simply won't resolve (no id → no walk), so graph channels reach secret *descendants of a resolvable public root* (§5.1 tier-annotates those), not secret *roots*.
- **Persist vs strip the lookup tool-result** (§6 codec mapping) — a one-line decision with a tier consequence.
- **NPC playbook-knowledge slice:** confirm `sd_playbook` carries enough per-NPC framing for the ST-vet's "what this NPC would convey," or pass the NPC's prose-kernel/facts alongside (resolver-fetchable; not a blocker).

## 12. References

- Multiplayer Session Runtime spec §17.4 (unified ST-gated retrieval), §17.5 (two channels), §17.6 (resolver mechanism, no-tier-filter, empty≠invent), §17.7 (write-authority map — Class 2 is MYT-73), §17.8 (open: ST job scope).
- MYT-69 SlowThinker design §4 (the §8.2 direction-channel bound the relay widens).
- MYT-71 world-store retrieval (the resolver barrel `world/retrieval/index.ts`; `LoreHit.accessLevel` tiering).
- Code: `session/tiers/ft-tools.ts`, `fast-thinker.ts`, `skill-check.ts`, `st-gate.ts`/`st-director.ts`, `st-evaluation-worker.ts`, `turn-worker.ts` (`makeTiers`), `tiers/types.ts`.

## 13. Blind-review record — round 1 (theme: Mythological creatures, all-Opus)

Four reviewers, distinct lenses: **Sphinx** (enforced-ignorance / tier-leak), **Chimera** (LLM-orchestration / structured-output), **Basilisk** (session-runtime integration), **Phoenix** (game-design / mechanics). Verdict under the strict rubric: **~0–1 genuine SHOWSTOPPER** (Sphinx-C1, a tier-annotation gap the ST's `sd_playbook` partly covers) → **ship** (stopping rule 0–2), no round 2; every other finding is a real-but-fixable-inline correction or a plan-pinning item, all folded in. Corrections applied:

- **The central tier-leak fix (Sphinx-C1):** graph results (`KnownCharacter`/`FactionNode`) carry no `access_level`; the gate was blind on 2 of 3 substrates. → §5.1 (join `access_level` onto graph rows; ST-vet input tier-annotated) + §9 graph leak test.
- **Repair posture (Chimera-C1):** the ST-vet's prose is player-facing (like `st-director`, not code-consumed like `st-gate`); a repaired relay is text the gate didn't author. → §5 discard-on-repair → fail-soft.
- **Side-channel leak (Sphinx-C2):** the `ai.ts` `rawTextSnippet` egress (logs/SSE) for the one secret-bearing LLM call. → §5 suppress `rawTextSnippet`; §9(c) tests it.
- **Secret-aware standing (Phoenix-I2):** the public Haiku gate can't judge auto-success for a *secret*-backed role. → §4.1 public-standing-only gate + §5 ST-vet secret-aware override.
- **Boundary mechanism (Sphinx-I2 / Basilisk-I3):** pass an opaque `vet` closure, not raw `sd_playbook`; a separate narrow `sdPlaybook` read, not widening the `{ftContext}` surface. → §6.
- **Plumbing the spec assumed exists (Basilisk-C1/C2/I4):** `worldId` (new `getWorldId` read, cached on `:state`), the boot-probed embedder threaded into the turn worker, the name→id resolver. → §6, §10, §11.
- **Streaming-loop fit (Basilisk-I1, Chimera-I4):** `ST_LOOKUP_VET_TIMEOUT_MS` under the FT turn budget; vet timeout → fail-soft before the turn abort. → §5, §7.
- **Schema (Chimera-I1/C2/M2):** flatten the DC-table (no root union); add `tier` provenance for MYT-73; `text` no `.max()`. → §4.1, §5, §10.
- **Invent quality (Chimera-I3 / Phoenix-M2):** the ST-vet was transcript-blind → give it recent narrative context so `invent` is thread-consistent. → §5, §8.
- **Degraded ≠ empty (Phoenix-M4):** `resolver_degraded` signal so an infra blip doesn't trigger a confident invention. → §7.
- **Codec (Sphinx-I1):** the new tool names crash `assistantToRows`; add the mapping or strip. → §6, §11.
- **Game mechanics (Phoenix-I3/I4):** NPC renders identically auto-success vs hidden-pass (no metagame tell); DM skill constrained to a knowledge enum; passive-check framing for public auto-success; `entityId`-seeded NPC stat fab. → §4.2.
- **Relay-only challenge (Phoenix-C1):** kept (user's informed D1); the fixable transcript-blindness part folded in; the cross-lookup divergence surfaced as the explicit accepted limit (MYT-73 closes it). → §8.
- **Module placement (Basilisk-M1):** the ST wrappers live in `llm/`, not `session/`. → §5, §10, §11.
