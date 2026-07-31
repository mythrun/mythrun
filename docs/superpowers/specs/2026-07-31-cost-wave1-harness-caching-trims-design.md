# Cost Program Wave 1 — Cost-Assertion Harness + Caching — Design (v2)

**Date:** 2026-07-31 (v2 after blind round 1: OPT-8 rescoped — per-stage schemas invalidate the prompt cache, cross-stage sharing is provider-impossible; OPT-1 gains its enabling ai.ts contract extension; OPT-7 inverted to cache-first with content trims deferred to Wave 4's evals)
**Program source:** `tmp/2026-07-30-pricing-restructure-and-cost-reduction-plan.md`. Wave 1 of four: Wave 2 = OPT-9 meter (+ farewell/END bugs), Wave 3 = pricing/Stripe (Miklos's §5 decisions), Wave 4 = cadence + model swaps behind evals (incl. any meaning-bearing prompt trims). OPT-10 shipped 2026-07-30.
**Decisions locked:** Wave 1 first; smokes on-demand (per-OPT proof gate) + weekly staging; never in pre-push/CI.

**Honest expected outcome (revised in v2):** the wave's dollars come from caching, not trims — ST evals ~90% off the cached span (today `cacheRead = 0`), the per-turn Haiku calls (gate + tripwire) cached (~$0.67/2.5h-session, bigger and safer than the abandoned trim), and same-schema retry reuse in prep. **The program doc's world $1.40 → $1.20 (OPT-8) does NOT survive review** — cross-stage cache sharing is impossible (§3) — and the program-level tracking must be updated. Meaning-bearing trims (gate content, FT payload) are Wave-4 work behind quality evals.

---

## 1. Cost-assertion harness (`backend/scripts/cost/`)

### 1.0 Enabling instrumentation (small, named — v1's "no new instrumentation" was false)

- `providerOptions.mythrun` (sessionId + stage/callSite label) attached at the call sites that today emit anonymous lines: ST director, ST gate, turn audit, DM-trigger classifier, session reconciler, post-session analysis. Without ids, Haiku lines (gate vs audit vs DC) are unattributable and scenario scoping degrades to timestamps.
- `cacheWriteTokens` added to the `llm.call` LogBindings (one field; the 1.25× write premium is otherwise unpriceable and a misplaced breakpoint that rewrites the prefix every call is otherwise invisible).

### 1.1 Runner

`backend/scripts/cost/cost-smoke.ts <scenario>`:

1. Targets the RUNNING local stack (refuses to boot its own; liveness precondition includes "expected log files present and fresh") or staging (weekly mode, CloudWatch capture).
2. Executes the named scenario (§5).
3. Captures `llm.call` NDJSON from **BOTH** dev log files (`backend/logs/dev-<date>.log` API leg + `dev-worker-<date>.log` worker leg — queue-driven calls log to the worker; in-request calls to the API; the log-file precondition means `pnpm dev`/dev-logged only). Multi-file, midnight-spanning-safe. Scoped by scenario-correlated ids (§1.0) + the window; **window close = queue quiescence** (expected-count-with-timeout), never the last WS frame — turn N's eval/audit/scribe land after the stream ends.
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

The FT's proven mechanism is message-level `providerOptions.anthropic.cacheControl` on a messages array. The canonical wrapper's `generateObject`/`streamObject`/loop paths accept only flat `prompt: string` (+ optional `system`) — **there is nowhere to hang a breakpoint**, and call-level providerOptions is documented inert. Wave 1 therefore extends the single-abstraction-layer contract:

- New optional input shape on the three entry points: an ordered list of prompt blocks `{text, cacheBreakpoint?: boolean}` (system + user spans), compiled inside ai.ts to the SDK messages form with per-block `cacheControl` — flat `prompt` remains supported unchanged.
- The loop path (`stageBudgetMs` calls) threads blocks through `driveStreamingObjectAttempt` identically.
- Tested at the wrapper level: block compilation, breakpoint placement, legacy-path byte-identity.
- **Positive interaction (noted, free):** a loop attempt that fails after prompt processing has already written the cache — its retry reads it.

## 3. OPT-1 — ST prompt caching (+ the per-turn Haiku calls)

**ST eval (Opus):** reorder `st-evaluation.txt` stable-first and annotate via §2's blocks. Stable span (above the last breakpoint): template head + roster + sd_playbook. Below: everything ST-output-derived (running summary, standing directive, pending one-shot), the exchange window, and BOTH mode slots (`wind_down`/`converge` are per-phase — volatile). Baseline: 13 evals/session, 159k in, cacheRead = 0, $1.46. Cadence ~84s is safely inside the 5-min TTL; the gate's 5-turn skip floor can open ~7-min gaps — assertions accommodate (§5).

**Haiku gate + scribe tripwire (the review's cache-first inversion — bigger and safer than any trim):** both re-send per-session-stable spans every turn with cacheRead = 0. Gate: boilerplate + full sd_playbook (~7.5k of ~10k) cached ≈ $0.67/2.5h-session at zero quality risk. Tripwire: reorder stable-first (secrets/publicContext blocks are per-session-stable; the template currently leads with volatile prose). **Constraint that ordered this wave: Haiku 4.5's minimum cacheable prefix is 4096 tokens — any future gate trim below ~5k stable span forecloses caching; caching therefore lands FIRST and any residual trim is re-derived afterward (post-caching, trimmed playbook tokens are worth $0.10/MTok — near nothing).**

Schema note: these are structured-output calls — the schema is part of the cached prefix context and is per-call-site STABLE, so same-call-site caching works; the impossibility in §4 below is CROSS-schema only.

## 4. OPT-8 — rescoped: same-shape reuse only

**Cross-stage prefix sharing is provider-impossible and is dropped:** each stage call carries its own schema; on this stack the schema is delivered via `output_config.format`, and changing it "will invalidate any prompt cache for that conversation thread" (provider-documented). Independent blockers: adjacent-stage gaps exceed the 5-minute TTL (locations_and_npcs alone streams ~5 min), and the billing layer rejects 1h-cache tokens by policy. **The program doc's world $1.40 → $1.20 expectation is retired; program tracking updated.**

What remains (real, small): same-call-site reuse — session-prep's overflow-retry pair (same schema, near-identical prompt, minutes apart) and BullMQ/loop stage retries re-reading the attempt's own cache write. Annotate those call sites via §2's blocks; expected savings honest-small; proven by S-4's cacheRead-on-retry assertion rather than a blanket pipeline claim.

## 5. Scenario smokes (Wave 1 set)

| Smoke | Scenario | Asserts |
|---|---|---|
| S-1 | Constructed-state campaign, scripted 12-turn WS play incl. 2 skill checks (**new driver** — the existing smoke scripts drive in-process, not over WS; S-1's WS driver is new code and says so) | per-turn FT cost bracket; ST **$/eval** within band + eval count within an empirically measured range (no cadence config exists until Wave 4 — count is gate-driven and nondeterministic); total in-session $ **informational**, not gating |
| S-2 | S-1 turns 2+ | FT `cacheRead ≥ 85%`; ST: every eval EITHER `cacheRead > 0` OR is the session's first (cold write: `cacheWrite > 0`) OR follows a >TTL gap (logged, not failed); gate + tripwire `cacheRead > 0` from turn 2 |
| S-4 | Finalize character creation → prep pipeline | prep $ ≤ manifest; configured model asserted; retry-path `cacheRead > 0` when a retry occurs; ft_context/sd_playbook schema-valid |
| S-5 | Full prep-engine run on fixed input | per-stage $ ≤ manifest (per-model scoped); stage retry cost counted separately |

The wave's savings are proven per-call (token/$ deltas at the call sites); session-scale dollar claims are arithmetic extrapolation from these measurements and are labeled as such — S-6 (long-session) arrives with Wave 2's meter. S-3/S-7 also Wave 2.

## 6. What Wave 1 does NOT trim (deferred to Wave 4 behind evals)

- **Gate content:** the gate input is ~70–80% sd_playbook and every fire condition is playbook-relative; selecting "what the gate doesn't need" is meaning-bearing by construction and code-side selection is ZFC-forbidden. Any gate trim needs OPT-2's intervention-latency eval harness. Post-caching it's also nearly worthless.
- **Audit/scribe content:** the audit input IS the payload under audit + false-positive calibration (a player-trust boundary); the tripwire's publicContext is the false-retcon grounding floor. No provably-dead bytes identified.
- **FT fixed payload:** the span is ~91% cached — a 2.5k trim is worth ~$0.08/session against the product's core surface. Dropped.

## 7. Execution order within the wave

Harness instrumentation (§1.0) + runner + manifest → 3–5 baseline runs, bands pinned, S-4/S-5 green on as-built → §2 wrapper contract extension → OPT-1 ST caching (+S-2 ST assertions on) → gate + tripwire caching (+S-2 turn-2+ assertions on) → OPT-8-rescoped retry-reuse annotations → weekly ECS schedule wiring last.

## 8. Testing (beyond the smokes)

- Unit: manifest loader/tolerance; NDJSON extraction (fixtures incl. missing-cacheRead, multi-model, dual-file merge); the USD derivation against mapUsage's semantics; report rendering; §2 block compilation + breakpoint placement + legacy byte-identity.
- **Stable-span boundary test (not determinism):** the prefix up to the last breakpoint is byte-identical across assemblies with DIFFERENT per-turn state (changed summary/exchanges/directive/mode); the volatile suffix differs. Applied to ST, gate, tripwire assemblies.
- Prompt/schema constructed smokes re-run for every template reorder (co-evolution rule).

## 9. Out of scope (Wave 1)

- OPT-9 meter, `session_usage` trail, S-3/S-6/S-7 (Wave 2).
- Pricing/Stripe/tiers, paywall copy (Wave 3; Miklos's §5 decisions pending).
- Model swaps, ST cadence, and ALL meaning-bearing prompt trims (Wave 4, behind evals).
- CloudWatch $/hour alarm (standing alarm bead; `cost_smoke.failed` events land now).
