# Cost Program Wave 1 — Cost-Assertion Harness, ST/Prep Caching, Prompt Trims — Design

**Date:** 2026-07-31
**Program source:** `tmp/2026-07-30-pricing-restructure-and-cost-reduction-plan.md` (Miklos's plan; §4.1 harness, OPT-1, OPT-7, OPT-8, smokes S-1/S-2/S-4/S-5). This spec is Wave 1 of four: Wave 2 = OPT-9 session meter (+ farewell/END bugs), Wave 3 = pricing/Stripe restructure (blocked on Miklos's §5 decisions), Wave 4 = cadence + model swaps behind evals (OPT-2, 4/5/6, OPT-3 last). OPT-10 already shipped (the 2026-07-30 outage-resilience feature).
**Decisions locked in brainstorm:** start with Wave 1; cost smokes run **on-demand (per-OPT proof gate) + weekly scheduled against staging**; never in pre-push/CI.

**Goal:** pure-savings optimizations with wire-level dollar proof — no product decisions, no quality evals required. Expected outcomes (program doc §3): ST Opus input ~90% off on the cached span (today `cacheRead = 0` on every eval); world gen $1.40 → ~$1.20 with prep helped; ~$0.80/2.5h-session from trims; and a harness that makes every later OPT's dollars assertable.

---

## 1. Cost-assertion harness (`backend/scripts/cost/`)

### 1.1 Runner

`backend/scripts/cost/cost-smoke.ts <scenario> [--manifest <path>] [--log <path>]`:

1. Targets the RUNNING local stack (backend :3030 + worker + Postgres + Redis; the runner refuses to start its own — stack liveness is a precondition it checks and reports) or, in the weekly mode, the staging stack from inside the VPC.
2. Executes the named scenario (§3) end-to-end.
3. Captures usage from the **existing** `llm.call` structured logs (pino NDJSON; fields `inputTokens`, `outputTokens`, `cacheReadTokens`, `model`, `stage` already emitted by the cost middleware — no new instrumentation). Local capture = tailing the log file(s) the booted processes write, scoped to the scenario window by timestamp + scenario-correlated ids (campaignId/session id the scenario created). Staging capture = the same NDJSON via CloudWatch `filter-log-events` on the scenario window.
4. Computes USD per call via the existing model-pricing table (`backend/src/billing/model-pricing` — the single pricing source; the manifest never duplicates prices).
5. Asserts against the **expected-cost manifest** and prints the one-page report: component table (tokens in/out/cacheRead, $), delta vs manifest, PASS/FAIL per component and overall. **A red cost smoke is a red smoke** — same severity as a functional failure.

### 1.2 Manifest (`backend/scripts/cost/expected-costs.json`)

Checked in. Per-component entries: `{tokensIn, tokensOut, cacheReadMin?, usd, tolerancePct}` — tolerance defaults ±20%, per-entry overrides allowed. Initial entries seeded from the program doc §2 measured baselines (FT $/turn by context bracket; ST $/eval + evals/turn; prep total; reconcile total; analysis total; world-gen total per stage; session lifecycle total). **Each OPT landing updates its entries in the same commit as the optimization, with the passing cost-smoke report quoted in the commit message.** Anthropic price changes (the 2026-09-01 standard-rate flip) are a scheduled manifest update re-verified against S-1/S-2/S-4/S-5.

### 1.3 Weekly scheduled run

The same runner in the existing in-VPC ECS run-task family (the standing "fire in the VPC" pattern), EventBridge weekly schedule, against staging. Report lands in CloudWatch logs; failure emits a structured `cost_smoke.failed` event (alarm wiring rides the existing follow-up alarm bead — log events now, paging later). Estimated spend ~$2–4/week.

## 2. OPT-1 — ST prompt caching

The FT already proves the mechanism (`fast-thinker.ts` — message-level `cacheControl: {type:'ephemeral'}` breakpoints on the system message and the stable prefix; **call-level providerOptions is documented inert for cache_control on this provider**). The ST eval path (`st-director.ts`) adopts it:

- Reorder the ST prompt so stable content leads: system message (breakpoint) → stable campaign/world state block (breakpoint) → per-turn window. The stable span must be byte-identical across evals within a session for the cache to hit — the assembly is audited for anything per-turn (timestamps, turn counters) embedded in the stable span and such content moves below the breakpoint.
- No change to what the ST sees (enforced-ignorance boundaries untouched — the ST already sees everything; this is ordering + annotation only).
- Measured baseline: 13 Opus evals/session, 159,402 in, `cacheRead = 0`, $1.46/session. Expected: ~90% off the cached span.
- Proof: S-2's hard assertion `ST cacheRead > 0 on EVERY eval` + the S-1-lite total.

## 3. OPT-8 — world-gen + prep caching

Same mechanism across the prep engine: the pipeline stages re-send shared world-canon prefixes (canon/kernel blocks) per stage call; the stage-call assembly gains breakpoints on those shared prefixes (world-gen stages + session-prep's two calls). Stage prompts are ordered stable-first where they aren't already. Expected: world $1.40 → ~$1.20; prep total helped ahead of OPT-4's model swap. Proof: S-4/S-5 `cacheRead > 0` assertions + per-stage dollar bands.

## 4. OPT-7 — prompt trims

- Haiku gate input 10k → ~5k (the gate's fat context is the target; trim what the gate demonstrably doesn't need for its binary decision — content selection is reviewed against the gate's prompt template contract, not blind truncation).
- Audit/scribe per-turn trims.
- FT fixed payload 17.5k → 15k.
- Every trim follows the prompt+schema co-evolution rule: the existing prompt/schema constructed smokes re-run per trim, plus the cost smokes. Trims that would change MEANING (not just size) are out of scope for Wave 1 — flag, don't ship.

## 5. Scenario smokes (Wave 1 set)

| Smoke | Scenario | Asserts |
|---|---|---|
| S-1-lite | Constructed-state campaign, scripted 12-turn WS play incl. 2 skill checks (extends the existing `scripts/smoke` session-driving precedent) | per-turn FT cost bracket; ST eval count matches cadence config; total in-session $ within band |
| S-2 | S-1-lite turns 2+ | FT `cacheRead ≥ 85%` of input; **ST `cacheRead > 0` on every eval**; prep/world-gen `cacheRead > 0` (post-OPT-8) |
| S-4 | Finalize character creation → prep pipeline | prep $ ≤ manifest; configured model asserted; ft_context/sd_playbook schema-valid |
| S-5 | Full prep-engine run on a fixed input | per-stage $ ≤ manifest; stage retry cost counted separately |

S-3 (lifecycle), S-6 (long-session extrapolation), S-7 (cadence telemetry) belong to Wave 2 with the meter. Estimated on-demand full-run spend: ~$2–4.

## 6. Execution order within the wave

Harness + manifest first (it proves everything else) → S-4/S-5 green against as-built baselines → OPT-1 (+S-2 ST assertion flips on) → OPT-8 (+S-2 prep/world-gen assertions flip on) → OPT-7 trims (S-1-lite/S-2 re-baselined per trim) → weekly ECS schedule wiring last.

## 7. Testing (beyond the smokes themselves)

- Unit: manifest loader/tolerance math; NDJSON usage extraction (fixture log lines incl. missing-cacheRead and multi-model runs); USD computation against the pricing table; report rendering.
- The caching changes ship with assertion-bearing unit tests where the prompt assembly is pure (stable-span byte-stability across two assemblies of the same session state — the cache-hit precondition, testable without the API).
- Constructed prompt/schema smokes re-run per trim (existing suites).

## 8. Out of scope (Wave 1)

- OPT-9 meter, `session_usage` durable trail, S-3/S-6/S-7 (Wave 2 — the meter owns them).
- Any pricing/Stripe/tier change, paywall copy (Wave 3; Miklos's §5 decisions pending).
- Model swaps + their evals, ST cadence (Wave 4).
- CloudWatch $/hour alarm (rides the standing alarm bead; `cost_smoke.failed` events land now).
