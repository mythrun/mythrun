// MYT-69 §11 — SlowThinker + Haiku-gate tuning constants. The deterministic
// policy arms (floor turns, wind-down fraction) are CODE around the gate, not
// prompt content — mechanical policy, ZFC-exempt. Never hardcode model names
// or budgets at call sites.

import { HAIKU, OPUS } from '../llm/models.js'

/** The architecture's tier assignment: Opus narrates direction, Haiku gates. */
export const ST_MODEL = OPUS
export const ST_GATE_MODEL = HAIKU

/** runtime §8's every-5-turns oversight floor: turns-since-the-last-ST-RAN ≥
 *  this forces an evaluation, skipping the gate. "Evaluated" == an Opus ST ran
 *  (NOT a skipped gate). */
export const ST_EVAL_FLOOR_TURNS = 5

/** Skip the Opus call IFF `!needed && confidence ≥ this`. An EMPIRICAL knob —
 *  Haiku confidence calibration is poor; the §13 smoke measures the skip rate
 *  and tunes this. Only a confident "no" skips; everything else evaluates
 *  (fail-toward-oversight). */
export const ST_GATE_CONFIDENCE_FLOOR = 0.8

/** Recent-slice sizes (player+DM exchanges). The gate sees a tighter window;
 *  the evaluation sees more. Plan-time tune; the smoke validates. */
export const ST_GATE_EXCHANGE_WINDOW = 6
export const ST_EVAL_EXCHANGE_WINDOW = 10

/** The §3.11 session bound proxy — the total token budget that, at
 *  WIND_DOWN_FRACTION, trips the wind-down policy arm. Plan-time; tuned in the
 *  smoke. The FT-context hard cap (session-end issue) is the real bound; this
 *  is the ST-side signal.
 *
 *  400_000 -> 545_000 on the 2026-07-26 Sonnet 5 bump. This is NOT a decision to
 *  make sessions longer — it holds them where they already were. Sonnet 5's
 *  tokenizer spends ~35.6% more tokens on identical text (measured: 1175 -> 1593
 *  on 6KB of our own prep prompt), and the FT re-sends the whole transcript every
 *  turn, so the old 400_000 bought ~26% less actual story than it did the day
 *  before. 400_000 x 1.356 ~= 545_000 restores the prior session in PROSE terms
 *  rather than in token terms.
 *
 *  What this constant actually controls today is narrative pacing, not spend:
 *  the ST convergence/wind-down arms and the myth-nu0hm progress fraction read
 *  it, but the hard auto-end that was supposed to enforce it is dead code
 *  (myth-05p52 — recordUsage has no caller, so budgetSummary always reads zero).
 *  So raising it makes the DM land later and the progress band climb slower; it
 *  does not by itself authorise more spend. Sessions that genuinely run long do
 *  cost more, and note the Sonnet 5 introductory rate ends 2026-08-31 — an
 *  equal-length session is slightly cheaper than before until then, ~36% dearer
 *  after. Re-tune here if that step lands badly. */
export const SESSION_TOKEN_BUDGET = 545_000
export const WIND_DOWN_FRACTION = 0.9

/** myth-3jna1 — the CONVERGENCE steer, the stage before wind-down. Wind-down
 *  (0.9) says "close now"; convergence says "start drawing toward a place this
 *  can rest" while there is still session left to land it in. Three arms, in
 *  order: converge (0.75, only if the arc is behind) → wind-down (0.9) →
 *  farewell (1.0, the turn worker's auto-end).
 *
 *  CONVERGE_MECHANICAL_FLOOR is the mechanical fraction at which the (paid)
 *  narrative-progress probe starts running. 0.75 leaves ~100k tokens — at
 *  late-session turn sizes (the FT holds the whole transcript, so tail turns
 *  are the most expensive) that is roughly a handful of turns: enough for the
 *  DM to bring a live thread somewhere it can be set down, and still reach
 *  wind-down with room. Probing earlier would spend a quarter of every session
 *  in landing mode — the "wastes paid session" failure. The probe never runs
 *  below this, so three quarters of every session carries ZERO added spend.
 *
 *  CONVERGE_LAG_MARGIN is how far narrative progress must sit BELOW mechanical
 *  progress before the steer fires. A 0-1 arc judgment from Haiku is coarse;
 *  without a margin, "narrative 0.72 at mechanical 0.75" would trip the steer
 *  on judgment noise for a session that is in fact on pace. 0.10 is about one
 *  notch of that judgment's real resolution — at the 0.75 floor the steer needs
 *  narrative ≤ 0.65 to fire.
 *
 *  Both are PACING FEEL as much as arithmetic — real play is the only thing
 *  that settles them, so they live here as named constants and tuning is a
 *  one-line change. */
export const CONVERGE_MECHANICAL_FLOOR = 0.75
export const CONVERGE_LAG_MARGIN = 0.1

/** The narrative-progress probe's tier + budget. A cheap classification-shaped
 *  judgment → Haiku, same as the gate; same background-tolerant timeout (it
 *  runs in the ST job, and nothing player-visible waits on it). */
export const ST_PROGRESS_MODEL = HAIKU
export const ST_PROGRESS_TIMEOUT_MS = 30_000

/** Background-tolerant budgets (nothing player-visible waits on these). NOTE:
 *  ST_EVAL_TIMEOUT_MS > worker.ts WORKER_CLOSE_GRACE_MS slack only at the
 *  margin — a deploy mid-eval force-closes the worker and the job re-runs after
 *  reboot (double Opus spend per deploy-during-eval, accepted — §11). */
export const ST_EVAL_TIMEOUT_MS = 120_000
export const ST_GATE_TIMEOUT_MS = 30_000

/** reasoning + direction + a FULL summary rewrite is long; the SDK default
 *  truncates (§4). Raised 4_000 -> 16_000 for the Opus 5 bump — adaptive
 *  thinking is on by default and shares this ceiling with the rewrite, and the
 *  director's evaluation is the call where deep thinking is most wanted and
 *  most expensive in tokens. ST_EVAL_TIMEOUT_MS remains the wall-clock guard. */
export const ST_EVAL_MAX_OUTPUT_TOKENS = 16_000

/** The rewrite-semantics target (the prompt instructs this; not enforced in
 *  code — a hard max on prose is forbidden, feedback_no_max_on_llm_prose_fields). */
export const ST_SUMMARY_TARGET_WORDS = 250
