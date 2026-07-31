# Cost Program Wave 1 — Cost-Assertion Harness + Caching — Design (v3)

**Date:** 2026-07-31 (v3 — final. Blind round 1: OPT-8 cross-stage sharing provider-impossible, ai.ts seam named, OPT-7 inverted cache-first. Round 2: ZERO showstoppers; its nit pile folded here — OPT-8 residual retired on the corrected TTL clock, stale inertness claim fixed, 4096-span preconditions measured-not-assumed, tripwire decision-parity gate added.)
**Program source:** `tmp/2026-07-30-pricing-restructure-and-cost-reduction-plan.md`. Wave 1 of four: Wave 2 = OPT-9 meter (+ farewell/END bugs), Wave 3 = pricing/Stripe (Miklos's §5 decisions), Wave 4 = cadence + model swaps behind evals (incl. any meaning-bearing prompt trims). OPT-10 shipped 2026-07-30.
**Decisions locked:** Wave 1 first; smokes on-demand (per-OPT proof gate) + weekly staging; never in pre-push/CI.

**Honest expected outcome (revised in v2):** the wave's dollars come from caching, not trims — ST evals ~90% off the cached span (today `cacheRead = 0`), the per-turn Haiku calls (gate + tripwire) cached (~$0.67/2.5h-session, bigger and safer than the abandoned trim), and same-schema retry reuse in prep. **Program-tracking updates required (not just OPT-8):** the world $1.40 → $1.20 (OPT-8) claim is retired (cross-stage sharing impossible, and round 2 retired the retry-residual on the corrected TTL clock); OPT-7's $0.80 row is mostly ABSORBED by OPT-1 (they targeted the same bytes — post-caching, trimmed tokens are worth $0.10/MTok); and OPT-1×OPT-2 interact (every-3rd-turn cadence ≈ 4.2 min sits at the 5-min TTL edge — stacked gate skips cancel ST cache hits). The program's §3 expected totals are re-derived when Wave 3 prices against them. Meaning-bearing trims (gate content, FT payload) are Wave-4 work behind quality evals.

---

## 1. Cost-assertion harness (`backend/scripts/cost/`)

### 1.0 Enabling instrumentation (small, named — v1's "no new instrumentation" was false)

- `providerOptions.mythrun` (sessionId + stage/callSite label — riding the existing `stage` string; state so, so implementers don't fork the context shape) attached at EVERY per-turn/per-session call site that today emits anonymous lines: ST director, ST gate, turn audit, DM-trigger classifier, **secret tripwire, skill-check DC, input-side gates (input gate/profanity), st-narrative-progress, st-lookup-vet, world-lookup-gate**, session reconciler, post-session analysis. Without ids, Haiku lines are unattributable and scenario scoping degrades to timestamps. The NDJSON extractor DROPS-AND-FLAGS lines carrying unknown or world-gen stages inside a session window (repair calls stamp world-gen stages and would otherwise misattribute).
- `cacheWriteTokens` added to the `llm.call` LogBindings — BOTH emission paths (wrapGenerate bindings AND the stream-side StreamTelemetry; the worker leg is stream-transport) — the 1.25× write premium is otherwise unpriceable and a misplaced breakpoint that rewrites the prefix every call is otherwise invisible. §8's unit fixtures include a stream-mode line.

### 1.1 Runner

`backend/scripts/cost/cost-smoke.ts <scenario>`:

1. Targets the RUNNING local stack (refuses to boot its own; liveness precondition includes "expected log files present and fresh") or staging (weekly mode, CloudWatch capture — BOTH log groups: the worker's and the API's; the dual-leg split is identical there).
2. Executes the named scenario (§5).
3. Captures `llm.call` NDJSON from **BOTH** dev log files (`backend/logs/dev-<date>.log` API leg + `dev-worker-<date>.log` worker leg — queue-driven calls log to the worker; in-request calls to the API; the log-file precondition means `pnpm dev`/dev-logged only). Multi-file, midnight-spanning-safe. Scoped by scenario-correlated ids (§1.0) + the window; **window close = drained-queue quiescence** (BullMQ waiting+active == 0 across the session queues, held for a settle interval — an expected-count definition would contradict S-1's own nondeterministic eval count), never the last WS frame — turn N's eval/audit/scribe land after the stream ends.
4. **USD derivation (normative — the naive reading is 3–5× wrong):** logged `inputTokens` is the SDK SUM (noCache + cacheRead + cacheWrite). Price as: base = `inputTokens − cacheReadTokens − cacheWriteTokens` at the input rate; `cacheReadTokens` at the cache-read rate; `cacheWriteTokens` at 1.25×; output at the output rate — mirroring `mapUsage` in cost-middleware.ts. Prices only from the existing model-pricing table (single source; it deliberately holds sticker rates).
5. Asserts vs the manifest; prints the one-page component report. A red cost smoke is a red smoke.

### 1.2 Manifest (`backend/scripts/cost/expected-costs.json`)

- **Token** budgets seeded from the program doc §2 measurements; **dollar** budgets seeded from the harness's own first verified runs (table-rate-computed) — §2's dollars are intro-priced and would red against the sticker-rate table on day one. The 2026-09-01 flip is therefore a no-op for the harness.
- **Bands pinned only after 3–5 baseline runs per scenario** (the §2 basis is n=1; adaptive-thinking Opus output is the high-variance term). Defaults ±20% with per-entry overrides derived from observed spread.
- Cache assertions are **per-model scoped** (caches never cross models) and TTL-aware (5-minute ephemeral only — the billing layer rejects 1h-cache tokens by policy).
- Each OPT landing updates its entries in the same commit, quoting the passing report.

### 1.3 Weekly scheduled run

The existing `mythrun-staging-smoke-*` ECS run-task family gains a cost-smoke task + an EventBridge weekly schedule (new wiring — the family exists, the schedule doesn't). Failure emits `cost_smoke.failed` structured logs (alarm wiring rides the standing alarm bead). ~$2–4/week.

## 2. The enabling seam — cacheControl-capable contract on the ai.ts wrapper (NEW, load-bearing)

The FT's proven mechanism is message-level `providerOptions.anthropic.cacheControl` on a messages array. The canonical wrapper's `generateObject`/`streamObject`/loop paths accept only flat `prompt: string` (+ optional `system`) — **there is nowhere to hang a breakpoint** (and the only reachable knob, call-level providerOptions, buys wrong-placement auto-caching — see the corrected premise below). Wave 1 therefore extends the single-abstraction-layer contract:

- New optional input shape on the three entry points: an ordered list of prompt blocks `{text, cacheBreakpoint?: boolean}` (system + user spans), compiled inside ai.ts to the SDK messages form with per-block `cacheControl` — flat `prompt` remains supported unchanged. The compiler asserts ≤4 breakpoints per request (the provider only WARNS on excess).
- **Corrected premise (round 2):** call-level `providerOptions.anthropic.cacheControl` is NOT inert on the installed provider — it now maps to top-level auto-caching of the LAST cacheable block, which for a flat volatile-suffixed prompt buys the write premium with near-zero reads. Wrong-placement, not no-op: a shortcut implementation would silently burn money. The blocks seam remains the right mechanism; §2's tests assert breakpoints land via the BLOCKS path (and the stale 'inert' code comments in fast-thinker.ts/ai.ts are corrected when touched).
- The loop path (`stageBudgetMs` calls) threads blocks through `driveStreamingObjectAttempt` identically.
- Tested at the wrapper level: block compilation, breakpoint placement, legacy-path byte-identity.
- **Positive interaction (noted, unasserted):** a loop attempt that fails AFTER prompt processing has already written the cache; its retry reads it free IF attempt-duration + backoff stay inside the 5-min TTL (the clock runs from the failing attempt's prompt processing — see §4).

## 3. OPT-1 — ST prompt caching (+ the per-turn Haiku calls)

**ST eval (Opus):** reorder `st-evaluation.txt` stable-first and annotate via §2's blocks. Stable span (above the last breakpoint): template head + roster + sd_playbook. Below: everything ST-output-derived (running summary, standing directive, pending one-shot), the exchange window, and BOTH mode slots (`wind_down`/`converge` are per-phase — volatile). Baseline: 13 evals/session, 159k in, cacheRead = 0, $1.46. Cadence ~84s is safely inside the 5-min TTL; the gate's 5-turn skip floor can open ~7-min gaps — assertions accommodate (§5). The roster sits in the stable span and is only QUASI-stable (multiplayer join/leave rewrites it) — S-2's accommodation list includes a logged 'stable-span changed' arm.

**Haiku gate + scribe tripwire (the review's cache-first inversion — bigger and safer than any trim):** both re-send per-session-stable spans every turn with cacheRead = 0. Gate: boilerplate + full sd_playbook (~7.5k of ~10k) cached ≈ $0.67/2.5h-session at zero quality risk. Tripwire: reorder stable-first (secrets/publicContext blocks are per-session-stable; the template currently leads with volatile prose). **Constraint that ordered this wave: Haiku 4.5's minimum cacheable prefix is 4096 tokens — any future gate trim below ~5k stable span forecloses caching; caching therefore lands FIRST and any residual trim is re-derived afterward (post-caching, trimmed playbook tokens are worth $0.10/MTok — near nothing).** **The same minimum is a measured precondition, not an assumption:** the tripwire's stable span (instruction head + secrets + publicContext + consistencyContext) and lean-campaign gate spans are TOKEN-COUNTED during the §7 baseline runs and recorded in the manifest; below 4096 the provider silently doesn't cache (cacheWrite 0, no error), so S-2's Haiku arms are CONDITIONAL on span ≥ minimum (logged-not-failed below). Production caching benefit scales with prep size — noted, expected.

**Tripwire decision-parity gate (the reorder is meaning-adjacent on a player-trust surface):** the tripwire's instruction text is order-referential and its current volatile-first layout is deliberate; the stable-first reorder therefore ships only after the existing constructed-state tripwire scenarios (grounded→none, consistency→soft, seeded-reveal→hard) produce IDENTICAL severity outcomes before/after. The gate's caching needs no such gate — st-gate.txt is already stable-first; its annotation touches zero bytes. Gate cache lines exist only on turns the gate actually runs (forced-eval turns skip it — S-2 scopes accordingly, and the constructed campaign seeds usage counters well below the wind-down fraction so the mode arms don't flip mid-scenario).

Schema note: these are structured-output calls — the schema rides the request's `output_config.format` parameter and is part of the CACHE KEY (not prompt bytes above a breakpoint); it is per-call-site STABLE so same-call-site caching works; the impossibility in §4 below is CROSS-schema only.

## 4. OPT-8 — rescoped: same-shape reuse only

**Cross-stage prefix sharing is provider-impossible and is dropped:** each stage call carries its own schema; on this stack the schema is delivered via `output_config.format`, and changing it "will invalidate any prompt cache for that conversation thread" (provider-documented). Independent blockers: adjacent-stage gaps exceed the 5-minute TTL (locations_and_npcs alone streams ~5 min), and the billing layer rejects 1h-cache tokens by policy. **The program doc's world $1.40 → $1.20 expectation is retired; program tracking updated.**

**Round 2 retired the residual too — the TTL clock runs from the FAILING attempt's PROMPT PROCESSING, not its end.** The flagship overflow-retry pair streams for minutes before failing, so its retry reads an already-expired entry; annotating the prep site would pay the 1.25× write premium on EVERY normal call for reads that almost never occur (negative expected value). OPT-8 is therefore reduced to a documentation note: loop-path retries that fail AFTER prompt processing but within TTL+backoff read their own write for free — true, unasserted, unannotated. No prep-site cache annotations ship in Wave 1; S-4/S-5 carry NO retry-cache assertions.

## 5. Scenario smokes (Wave 1 set)

| Smoke | Scenario | Asserts |
|---|---|---|
| S-1 | Constructed-state campaign, scripted 12-turn WS play incl. 2 skill checks (**new driver** — reuses ws-transport.ts's ticket/first-frame plumbing but turn-driving over WS is new code with its own E2E smoke; single-player, so DM-trigger attribution stays unproven until Wave 2's multiplayer scenario — noted) | per-turn FT cost bracket (scenario MEAN within band; individual turns informational); ST **mean $/eval** within band (per-eval assertions would flake on adaptive-thinking variance) + eval count within an empirically measured range (no cadence config exists until Wave 4); total in-session $ **informational** |
| S-2 | S-1 turns 2+ | FT `cacheRead ≥ 85%`; ST: every eval EITHER `cacheRead > 0` OR is the session's first (cold write: `cacheWrite > 0`) OR follows a >TTL gap (logged, not failed); gate `cacheRead > 0` on gate-running turns from turn 2; tripwire `cacheRead > 0` from turn 2 CONDITIONAL on measured span ≥ 4096 (logged-not-failed below); logged arms for >TTL gaps and stable-span (roster) changes |
| S-4 | Finalize character creation → prep pipeline | prep $ ≤ manifest; configured model asserted; ft_context/sd_playbook schema-valid |
| S-5 | Full prep-engine run on fixed input | per-stage $ ≤ manifest (per-model scoped); stage retry cost counted separately |

The wave's savings are proven per-call (token/$ deltas at the call sites); session-scale dollar claims are arithmetic extrapolation from these measurements and are labeled as such — S-6 (long-session) arrives with Wave 2's meter. S-3/S-7 also Wave 2.

## 6. What Wave 1 does NOT trim (deferred to Wave 4 behind evals)

- **Gate content:** the gate input is ~70–80% sd_playbook and every fire condition is playbook-relative; selecting "what the gate doesn't need" is meaning-bearing by construction and code-side selection is ZFC-forbidden. Any gate trim needs OPT-2's intervention-latency eval harness. Post-caching it's also nearly worthless.
- **Audit/scribe content:** the audit input IS the payload under audit + false-positive calibration (a player-trust boundary); the tripwire's publicContext is the false-retcon grounding floor. No provably-dead bytes identified.
- **FT fixed payload:** the span is ~91% cached — a 2.5k trim is worth ~$0.08/session against the product's core surface. Dropped.

## 7. Execution order within the wave

Harness instrumentation (§1.0) + runner + manifest → **S-1's WS turn-driver (its own E2E smoke)** → 3–5 baseline runs (incl. span token-counts recorded), bands pinned, S-4/S-5 green on as-built → §2 wrapper contract extension → OPT-1 ST caching (+S-2 ST assertions on) → gate + tripwire caching (+S-2 turn-2+ assertions on) → weekly ECS schedule wiring last.

## 8. Testing (beyond the smokes)

- Unit: manifest loader/tolerance; NDJSON extraction (fixtures incl. missing-cacheRead, multi-model, dual-file merge); the USD derivation against mapUsage's semantics; report rendering; §2 block compilation + breakpoint placement + legacy byte-identity.
- **Stable-span boundary test (not determinism):** the prefix up to the last breakpoint is byte-identical across assemblies with DIFFERENT per-turn state (changed summary/exchanges/directive/mode); the volatile suffix differs. Applied to ST, gate, tripwire assemblies.
- Prompt/schema constructed smokes re-run for every template reorder (co-evolution rule).

## 9. Out of scope (Wave 1)

- OPT-9 meter, `session_usage` trail, S-3/S-6/S-7 (Wave 2).
- Pricing/Stripe/tiers, paywall copy (Wave 3; Miklos's §5 decisions pending).
- Model swaps, ST cadence, and ALL meaning-bearing prompt trims (Wave 4, behind evals).
- CloudWatch $/hour alarm (standing alarm bead; `cost_smoke.failed` events land now).
