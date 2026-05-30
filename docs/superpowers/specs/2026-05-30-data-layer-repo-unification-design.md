# Data-Layer Repository Unification — Design

> **Status:** design, pre-plan. Round-1 blind review (4 lenses — transaction-correctness, abstraction-design, migration-safety, enforced-ignorance/security) applied. Supersedes the MYT-34 "Namespace Deferral Policy" approach.
> **Audit artifact:** `tmp/data-layer-audit-2026-05-30.json` (344 DB-access sites, per-site target-method mapping — the literal migration checklist). Produced by the `data-layer-audit` workflow (10 agents, 2026-05-30). **The audit records *today's* signatures** (explicit `client: ClientLike` first-params, `opts.client` smuggling); the closure-binding mechanism below supersedes those — see the Migration note under "Internal mechanism."

## Goal

Unify **all** Postgres access in the backend behind a single `repo.X` namespace surface, with a `repo.transaction(tx => …)` callback primitive for multi-table atomic writes. Eliminate the two parasitic data-access patterns that grew up alongside the original repo bundle, and add an ESLint rule that makes their reintroduction a build failure.

## Motivation

The data layer drifted into **three coexisting tiers**:

- **Tier 1** — pool-bound `repo.X` factories (`createRepo` bundle: `users, worlds, campaigns, sessions, credits, invites, characters, characterConcepts`). The MYT-33/37-era surface. ~92 call sites.
- **Tier 2** — standalone client-passed modules (`entities, facts, proseKernels, relationships, entityHierarchy, statBlocks, purchases, userSubscriptions, stripeEvents`, plus `createPipelineRunsRepo`). Built by the prep-pipeline era, never folded into the bundle. ~74 call sites.
- **Tier 3** — raw inline SQL (`pool.query`/`client.query` with string literals) in route handlers and worker stages. **87 sites in application code** that must be absorbed.

This violates CLAUDE.md's "all DB access through the repository layer," produces doc drift (the spec describes `repo.X` everywhere; the code does not), and — most importantly — the ad-hoc client-threading in Tier 3 is the substrate of two production incidents this milestone already paid for:

- **MYT-55** — LLM calls held open inside `BEGIN`/`COMMIT`, tripping RDS `idle_in_transaction_session_timeout`. Fixed by scoping transactions to writes only, but the fix lives in hand-written `withTransaction(client, …)` blocks that the next contributor can re-break.
- **MYT-56** — `queue.add` *inside* a transaction → "enqueued but commit failed" zombie campaigns.

The refactor's transaction primitive makes the **MYT-55 class structurally impossible** (slow I/O physically cannot sit inside the callback under the compute-then-`repo.transaction(writes)` shape) and the **MYT-56 class lint-enforced + convention-guarded** (a targeted check flags `queue.add`/`.publish`/`.emit` inside a callback; side-effects move to after-commit via the return value). These are not symmetric guarantees — see the primitive's outcome contract below.

## Current state (audit summary)

- **Target surface:** 24 namespaces. Largest: `worlds` (24 methods), `campaigns` (22), `credits` (16), `characterConcepts` (14), `characters` (13), `users` (12).
- **20 transactional sites** (see §6) — the hard cases that dictate the transaction API.
- **87 Tier-3 inline-SQL sites** in application code to absorb.
- The standalone Tier-2 modules and `createPipelineRunsRepo` all fold into `createRepo`.

## Design

### The two access shapes

```ts
// Reads + single-statement writes — pool-bound, no transaction:
const campaign = await repo.campaigns.getById(id)

// Multi-table atomic writes — callback-scoped; slow I/O stays OUTSIDE:
const llm = await generateObject(...)            // ← slow work first (MYT-55)
const result = await repo.transaction(async (tx) => {
  await tx.worlds.insertGenerating(w)
  await tx.campaigns.insertSetup(c)
  await tx.credits.insertWorldGenDebit(d)
  await tx.pipelineRuns.insertSeedRow(p)
  return { campaignId: c.id }                     // ← side-effects use the return
}, { lockTimeoutMs: 5000, statementTimeoutMs: 10000 })
await queue.add('world-gen', result)              // ← enqueue AFTER commit (MYT-56)
```

### The transaction primitive

```ts
repo.transaction<T>(
  fn: (tx: TxRepo) => Promise<T>,
  opts?: { isolation?: IsolationLevel; lockTimeoutMs?: number; statementTimeoutMs?: number },
): Promise<T>
```

Semantics:
- `connect → BEGIN (+ per-call SET LOCAL prelude) → fn(tx) → COMMIT → release`; `ROLLBACK` on throw. `repo.transaction` **extends** — does not merely wrap — `backend/src/db/transaction.ts:withTransaction`, because the bare helper issues `BEGIN` with no `SET LOCAL` hook (see "opts").
- **Outcome contract is richer than throw/return** — the real sites need three terminal outcomes (billing `dispatchEvent` exercises all three): (a) **clean return → `COMMIT`**, and the return value carries any post-commit work (e.g. the ordered `finalizedEvents` array the world-gen stages publish *after* commit); (b) **thrown error → `ROLLBACK` + propagate** (this is what drives Stripe-webhook retry / surfaces a real failure); (c) **no-op / idempotent discard → the callback returns the `repo.ROLLBACK` sentinel → `ROLLBACK` with no error surfaced** (Stripe duplicate-redelivery and unknown-event paths take this; today they `ROLLBACK`/`COMMIT`-empty and must not masquerade as errors that trigger needless retries).
- `TxRepo` exposes the transaction-**composable** namespaces, every method closure-bound to the in-flight `PoolClient` (see "Internal mechanism"). It does **not** expose `.transaction` (no nesting — a nested `BEGIN` warns and the inner `COMMIT` would end the outer tx prematurely) and does **not** expose the connection-owning self-managing methods, so `tx.credits.atomicDebit` is a **compile error**, not a silent second-connection write. This eliminates the "remember to thread the same client to all N calls" footgun the audit flagged as highest-risk on the credit ledger.
- **The `tx` handle's lifetime is exactly the callback.** Post-rollback / post-commit recovery logic (e.g. `handleRegister`'s 23505 unique-violation re-fetch) runs *after* `repo.transaction` settles and MUST use the pool-bound `repo.X`, never a captured `tx` (whose client has been released to the pool). The bound client flips a `settled` flag in `finally`; calling any `tx.X` method after settlement throws a located "tx repo used after transaction settled" error rather than corrupting a recycled pooled connection.
- **No non-DB side-effects inside `fn`.** Enqueues / SSE publishes run *after* `repo.transaction` resolves, using its return value. MYT-55 (slow I/O in tx) is structurally impossible — the slow call cannot sit inside `fn` under the compute-then-`repo.transaction(writes)` shape. MYT-56 (enqueue in tx) is *not* fully structural: a targeted lint check flags `await <x>.add(` / `.publish(` / `.emit(` lexically inside a `repo.transaction` callback (the literal shape that caused MYT-56); indirect calls remain a code-review item.
- `opts` carries the per-call `SET LOCAL` knobs the audit found varying by site (register, billing webhook, world-create each differ). They are issued as `SET LOCAL` statements *inside* the BEGIN scope (a `SET LOCAL` with no active tx is a silent no-op, so ordering is load-bearing). `isolation` **defaults to `read committed`** — every current site pins it explicitly; never inherit the connection/RDS default. A primitive test asserts `SHOW lock_timeout` / `SHOW transaction_isolation` *inside* the callback return the requested values.

### Internal mechanism: closure-bound namespaces (the binder)

Each **composable** namespace is authored once as a *binder* over `ClientLike` (the `query`-only structural interface already in `_types.ts`, satisfied by both `Pool` and `PoolClient`). **No method takes a `client` parameter — the client is captured by the binder.**

```ts
const worldsNs = (c: ClientLike) => ({
  insertGenerating:  (input: InsertGeneratingInput) => /* c.query(...) */,
  getById:           (id: string)                   => /* c.query(* )            — full row */,
  getSnapshotSummary:(id: string)                   => /* c.query(allowlist cols) — enforced-ignorance */,
  // …
})
const creditsNs = (c: ClientLike) => ({
  getWorldGenBalance: (userId: string)   => /* c.query(...) */,   // pool peek OR locked re-read — identical SQL
  grantInTx:          (input: GrantInput) => /* c.query(...) */,  // composes INSIDE a caller's tx
  // …
})
const bindTx = (c: ClientLike) => ({ worlds: worldsNs(c), campaigns: campaignsNs(c), credits: creditsNs(c), /* …all composable namespaces */ })

// Self-managing methods own their own pool connection + advisory lock + SET LOCAL; bound ONLY on the pool surface.
const selfManagingCredits = (pool: Pool) => ({ atomicDebit: /* … */, grant: /* … */ })

export function createRepo(pool: Pool) {
  const base = bindTx(pool)                                        // pool-bound default surface
  return {
    ...base,
    credits: { ...base.credits, ...selfManagingCredits(pool) },    // pool surface = composable ∪ self-managing
    invites: { ...base.invites, ...selfManagingInvites(pool) },
    users:   { ...base.users,   getByCognitoSubWithTimeout: /* … */ },
    transaction: <T>(fn: (tx: TxRepo) => Promise<T>, opts?: TxOpts) =>
      withTransactionWithOpts(pool, opts, (c) => fn(bindTx(c))),   // tx-bound surface
  }
}
export type TxRepo = ReturnType<typeof bindTx>   // composable namespaces only — naturally lacks `.transaction` AND the self-managing methods
export type Repo   = ReturnType<typeof createRepo>
```

`createRepo(pool)` binds the pool; `repo.transaction` binds the in-flight tx client. **One method body, two bindings, zero per-method duplication.** `TxRepo = ReturnType<typeof bindTx>` mechanically excludes both `.transaction` (added at the top level, not inside `bindTx`) and the self-managing methods (added only on the pool repo) — that exclusion is the structural guarantee, not a convention. This is what lets `getWorldGenBalance` serve both the un-locked peek (`repo.credits.getWorldGenBalance(userId)`) and the under-advisory-lock re-read (`tx.credits.getWorldGenBalance(userId)`) with *identical* SQL and **no `opts.client`** — a correctness requirement the audit called out.

> **Migration note (resolves the spec/audit mechanism contradiction):** the audit artifact records today's signatures, where ~107 Tier-2/inline methods take an explicit `client: ClientLike` first parameter (e.g. `entities.insert(client, …)`) and `getWorldGenBalance` smuggles a client via `opts?: { client? }`. **Those explicit-client parameters and the `opts.client` idiom are artifacts of the current code and are dropped during migration** — the closure binder supplies the client. The footgun the refactor exists to kill (threading the *wrong* client, or the pool where a tx client was meant) only disappears once the client is invisible at the call site; keeping it as a first arg would preserve the hazard. Where the audit's `proposedRepoMethod` shows a `client`/`opts.client` parameter, read it as "this method joins `bindTx`," not as the literal target signature.

### Two idioms (accepted)

A small set of **self-managing** methods own their own connection + advisory lock + per-call `SET LOCAL` timeouts + pg-error→typed-error mapping. They are bound **only on the pool surface** (not in `TxRepo`, so they can't be composed inside a callback as a silent second-connection write) and stay single-call: `credits.atomicDebit`, `credits.grant`, `invites.acceptInvite`/`create`, the `*ForUpdate` getters that own their lock, `users.getByCognitoSubWithTimeout`. Reworking them into the callback model would mean reimplementing their lock + timeout discipline for no benefit.

A method **stays self-managing** if it meets **any** of: (1) owns an advisory lock; (2) needs a baked-in `SET LOCAL` recipe distinct from its callers; (3) performs a **lock-order-sensitive multi-row `FOR UPDATE` sequence** whose ordering is load-bearing for deadlock avoidance — the refund path (`users → purchases ORDER BY id ASC → billing_history`) and `invites.create` (`campaigns → invites → members`) qualify, because a free-form `repo.transaction` callback would let a contributor reorder the locks and reintroduce deadlocks.

**`grantInTx` is the exception that proves the split:** it is *not* self-managing — it takes the tx client and **composes inside a caller's transaction** (register, the billing webhooks). It is a composable `TxRepo` method; only `grant` (pool-bound, owns its three `SET LOCAL`s) is self-managing. (The audit's "`grant`/`grantInTx` self-managing" note conflates the two — they are deliberately on opposite sides of this line.)

### Enforced-ignorance split (hard rule, non-negotiable)

The allowlist projection that omits `key_tensions`, `political_summary`, `world_overview`, `geography_summary`, `starting_situations`, `follow_up_questions` lives today *inline* inside `worldSnapshotView.fetch` — there is **no `getSnapshotSummary` method yet**. **This refactor creates `repo.worlds.getSnapshotSummary` as its named, single-sourced home**, distinct from `repo.worlds.getById` (full row). `repo.worldSnapshot.fetch` composes `getSnapshotSummary`; the allowlist column list exists in exactly one place.

The boundary is enforced by the **type system**, not a review note: `getSnapshotSummary` returns `WorldSummary`, a type that structurally cannot hold the plot columns. Re-pointing a Fast-Thinker path at `getById` is therefore a **compile error** (wrong return type), not a silent leak. The Fast Thinker path must only ever reach `getSnapshotSummary`. **Do not satisfy the player-facing world read with `getById`** — that re-exposes plot fields. This is a CLAUDE.md Non-Negotiable Principle.

**Tier-signal convention.** Unification moves the ~11 prep-stage plot-column reads onto `repo.worlds` (today their tier is signalled by living under `llm/prep/`). To preserve the signal once file location no longer carries it, plot-bearing `repo.worlds` accessors return clearly prep-tier-named types (e.g. `WorldGenContext`) and carry a one-line doc-comment: *"returns plot columns — prep/Slow-Thinker tier ONLY; player-facing reads use `getSnapshotSummary`."* The lint rule does **not** guard this split (both are repo methods, no raw SQL) — the type system + the all-access-through-repo discipline are the real guards.

> **Naming:** `repo.worlds.getSnapshotSummary` (allowlist projection) vs `repo.worldSnapshot.fetch` (composite tier-aware read view) are deliberately close. The existing `worldSnapshotView` naming exists to avoid a grep collision with the prototype-era `world_snapshots` save-game table; keep the `fetch`/`View` disambiguation when homing the namespace.

### Resolved design calls (open questions from the audit)

- **`findOrCreateStripeCustomer`** — the Stripe API call moves *out* of the repo. `repo.users` stays pure-DB (`getStripeCustomerId`, `setStripeCustomerId`); the billing route/service orchestrates check→Stripe→persist. To keep the now-split path idempotent under concurrent first-purchase requests (check→Stripe→persist is a TOCTOU — two requests both miss, both create a Stripe customer), `setStripeCustomerId` is an idempotent upsert (`ON CONFLICT … DO NOTHING RETURNING`, backed by a unique constraint on `users.stripe_customer_id`) so a lost race reuses the persisted id. (Touches a billing path — call out at review.)
- **`insertAdminGrant`** — **stays in its own `backend/src/repo/credit-grants.ts` module; NOT folded into `createCreditsRepo`.** This is deliberate: `'admin'` is intentionally excluded from the production `CreditSourceType` union, so the production `grant` surface *cannot* accept it. Fencing is **primarily the boot-time env gate** — `loadEnv` rejects `AUTH_MODE=bypass` under `NODE_ENV=production`, so the dev-credits plugin cannot even register in prod — plus the register/wire gates. It is **not** a per-call runtime `if` (boot refusal is the stronger guarantee; do not weaken it to a runtime check). The namespace table lists it under `credits` for discoverability only; physically it never joins the production credits bundle.
- **`pipelineRuns.claimStage`** — keep the `ClaimRequest` discriminated union (`world` / `campaign-user` / `campaign`). The three completion writers collapse to one `markStageCompleted`, but the **token-presence invariant is encoded in the discriminated union** (the `world` / `campaign-user` variants carry `inputTokens`/`outputTokens`; the `campaign` variant structurally omits them) — not as loose optional fields a caller can mis-populate.
- **`coherence-pass`** — migrates to the **standard stage shape**, NOT a special externally-opened-client variant. The current code already runs its cost-cap reads + the `generateObject` LLM call on a pooled client and opens a transaction for *only* the apply-patch writes; it becomes `reads + LLM (outside) → repo.transaction(tx => apply-patch writes)`. So `repo.transaction` needs **no** "construct from an externally-supplied open client" mode and there is **no** re-entrancy / nested-`BEGIN` case. (Resolves the audit's open question, which mis-stated an outer `BEGIN` that the code does not issue.)
- **Cross-domain join projections** — homed by primary intent: party roster (`campaign_members ⋈ users ⋈ concepts ⋈ campaign_characters`) → `repo.campaigns.getPartyRoster`; finalized-PC list → `repo.characters.listCampaignCharacters`; integration party (concept-anchored) → `repo.characterConcepts.loadCompletedParty`; `campaigns ⋈ worlds` context loaders stay composite methods on `repo.campaigns`. Under closure-binding these are available pool- *and* tx-bound for free.
- **Lock-acquisition ordering** — the canonical lock-orders are **named and owned by self-managing methods**, not left to callback discipline: refund = `users → purchases (id ASC) → billing_history`; `invites.create` = `campaigns → invites → members`. Documented in the repo layer; the multi-row-lock sequences stay self-managing (see "Two idioms") precisely so the order can't be reordered at a call site.

## Target namespace surface

24 namespaces (method counts; full per-method signatures + the call sites each replaces live in the audit artifact):

| Namespace | Methods | Notable |
|---|---|---|
| `users` | 12 | `getByCognitoSub` (11 sites), `getByIdForUpdate` (7, self-managing), `findOrCreateStripeCustomer` (Stripe call moves out) |
| `worlds` | 24 | `getById` (8) vs `getSnapshotSummary` (enforced-ignorance split); `setStatus` (7); concept/vocab/overview/starting-situation column writers |
| `campaigns` | 22 | `getById` (18); `findInFlightGenerationForUser`, `getPartyRoster`, `loadWorldGenContext` (absorb inline joins) |
| `credits` | 16 | `getWorldGenBalance` (3, pool peek + tx locked-reread, identical SQL), `grantInTx` (composable), `atomicDebit`/`grant` (self-managing), `insertAdminGrant` (dev-only; stays in `credit-grants.ts`, never folded into the bundle) |
| `characterConcepts` | 14 | `loadCompletedParty`, status-machine writers |
| `characters` | 13 | `replaceSubTables` (8 — absorbs the 4 child-table inline writes), `getFullCharacter` (4), `listCampaignCharacters` |
| `pipelineRuns` | 9 | `claimStage` (12, discriminated union), `markStageCompleted`/`markStageFailed` |
| `entities` | 10 | `insert` (7), `listByWorld` (4), `deleteByWorldAndCreatedIn`, `listStatBlockIdsForEntities` (absorbs the `world-snapshot-view.ts` inline stat-block-id read) |
| `sessions` | 7 | `recordUsage`, `budgetSummary` |
| `relationships` | 7 | `insertMany`/`insertOne`, `deleteByWorld` |
| `invites` | 6 | `acceptInvite`/`create` (self-managing) |
| `facts` | 6 | `insertMany` (5), `insertOne` (4) |
| `billingHistory` | 6 | append/find/markRefunded |
| `randomTables` | 5 | `insertTable`/`insertEntries`/`deleteByWorld` (absorb inline) |
| `proseKernels` | 4 | `insert` (5) |
| `purchases` | 4 | |
| `entityHierarchy` | 3 | `insert` (3) |
| `userSubscriptions` | 3 | |
| `settings` | 1 | `getValue` (4 — absorbs cost-cap inline reads) |
| `statBlocks` | 1 | `listByIds` |
| `worldSnapshot` | 1 | `fetch` (composite tier-aware read view) |
| `worldInventory` | 1 | `load` (4 — composite world-dump read) |
| `stripeEvents` | 1 | `recordOrSkip` |

## Transaction-site catalog (the 20 hard cases)

These define the migration's risk surface. Each becomes a `repo.transaction` callback (or, for the self-managing ones, stays as-is):

- **Routes:** `executeCreateTransaction` (5-table world+campaign create, advisory-locked balance re-read), `POST /characters` (concept upsert→flip→enqueue), `POST /finalize-character-creation`, `handleRegister` (3-write register; 23505 recovery re-fetches on the *pool* after rollback).
- **Billing:** webhook `dispatchEvent` (6 tables; three terminal outcomes — see the primitive's outcome contract), `webhook-refund` (clawback under lock, `users → purchases(id ASC) → billing_history` order — stays self-managing).
- **World-gen stages (9):** concept-intake, world-and-factions (`persistTree`), locations-and-npcs (`persistAndCollectEvents`), entity-relationships, entity-consolidation, starting-situation, random-tables, coherence-pass (**reads + LLM outside; `repo.transaction` for the apply-patch writes only** — not an externally-opened tx), plus character-sheet `persistCharacter` (6 tables) and character-integration `writeIntegration` (7 tables).
- **`cost-cap.ts`** `issueCostCapRefund` (hand-rolled BEGIN/COMMIT → `repo.transaction`).
- **Self-managing (stay):** `credits.atomicDebit`, `credits.grant`, `invites.acceptInvite`/`create`. (`grantInTx` is *composable* — it runs inside the register / billing-webhook callbacks, not as a self-managing method.)

> **Intentionally pool-bound writes (do NOT fold into a stage callback):** the world-gen processor's `markStageCompleted` / `markStageFailed` / `markWorldComplete` and the retry/eager status `UPDATE worlds … status=…` run on `deps.pool` *outside* the stage transaction **by design** — a failed-status write must persist even when the stage tx rolled back. These migrate to `repo.X` (pool-bound), never into the stage's `repo.transaction(tx => …)`. This is the inverse of the usual "thread the client" guidance and is easy to get wrong; a naive "route all `worlds` writes through `tx.worlds`" pass breaks error recovery.

## The lint rule

`backend/eslint-rules/no-raw-db-access` — modeled on the existing Stripe AST tripwires, but with **new path-aware logic** (the Stripe rules fire everywhere; this one needs a per-file allowlist):
- Flag `MemberExpression` callee `.query` / `.connect` (catches `pool.query`, `client.query`, `pool.connect`).
- Flag the realistic **evasions**, not just the literal call: **destructuring** (`const { query } = pool`), **aliasing** (`const q = pool.query.bind(pool)`), and `pg` imports in default / namespace / **dynamic** (`import('pg')`) forms.
- **Ban defining a raw-SQL pass-through helper inside an allowlisted dir** — a function in `repo/` that takes a SQL-string parameter and forwards it to `.query` re-creates the exact "blessed escape hatch" the MYT-55/56 incidents came from. This is the most important clause, because the allowlist would otherwise launder it.
- Flag `BEGIN`/`COMMIT`/`ROLLBACK`/`SET LOCAL` string literals outside the allowlist.
- **Targeted side-effect check:** flag `await <x>.add(` / `.publish(` / `.emit(` lexically inside a `repo.transaction(async (tx) => { … })` callback body (the MYT-56 shape).
- **Allowlist (per-file, read from `context.filename` *inside* the rule — this is the new logic the Stripe rules lack):** `backend/src/repo/`, `backend/src/db/{migrate,transaction,postgres}.ts`, `backend/src/boot/migrations-current.ts`, `backend/src/server.ts`, `backend/src/worker.ts`, `backend/src/worker/health-server.ts`.
- **The matcher is a tripwire, not a wall** — residual evasions are documented in the rule header; the type system + all-access-through-repo discipline are the real guards (the rule cannot see the enforced-ignorance `getSnapshotSummary`→`getById` collapse — both are repo methods). A fixture test exists for *each* documented-as-caught case (destructure, alias, dynamic import, helper-in-`repo/`, side-effect-in-callback), not just the happy path.
- During migration: starts as a **warning** (CI runs `eslint` without `--max-warnings 0`, so the warning phase is genuinely green), flips to **error** per-directory. The per-directory error-flip and that directory's final migration commit are the **same PR** — a directory cannot flip until every transaction cluster touching files in it is fully migrated.

## Migration strategy: cluster-based, adapter-shim, continuously green

The unit of migration is **not** the namespace — it is the **transaction cluster**: the connected component of namespaces reachable through any shared `repo.transaction`. A single tx callback writes atomically across namespaces (`executeCreateTransaction` spans worlds+campaigns+credits+pipelineRuns+campaign_members; `dispatchEvent` spans six), so those namespaces must migrate **together**. If a tx site is half-migrated — `tx.worlds.insertGenerating` on `repo.transaction`'s client B while the surrounding hand-managed code still writes the other tables on its own `pool.connect()` client A — the advisory lock on A no longer protects the write on B. That **compiles, passes single-threaded tests, and breaks only under concurrency**: the exact MYT-55/56 class this refactor exists to eliminate. Clusters are derived mechanically from the audit's `transactionSites[].tablesTouched`:

- **Cluster A — world+campaign create:** `worlds, campaigns, credits, pipelineRuns` (+ `campaign_members`). Sites: `executeCreateTransaction`, the 9 world-gen stages, `cost-cap`.
- **Cluster B — billing:** `stripeEvents, billingHistory, credits, userSubscriptions, purchases, users`. Sites: webhook `dispatchEvent`, `webhook-refund`, `handleRegister`.
- **Cluster C — character:** `characterConcepts, characters, entities, facts, proseKernels, relationships` (+ `campaigns`). Sites: `POST /characters`, `finalize-character-creation`, character-sheet `persistCharacter`, character-integration `writeIntegration`.
- **Leaf (genuinely independent, parallelizable):** `settings, statBlocks, worldInventory, worldSnapshot, randomTables, sessions, entityHierarchy` — no shared tx, migrate alone in any order.

`credits` appears in both A and B (`grantInTx` composes in create, register, and the webhooks); whichever cluster migrates first owns the `credits`/`grantInTx` bodies, and the other consumes them. `grantInTx`'s hand-managed-tx callers (`webhook-*.ts`, `users.ts handleRegister`) are themselves transaction sites — they convert to `repo.transaction` before `backend/src/billing/` and `routes/users.ts` can flip to lint-error.

Phases:

1. **Foundation (1a + 1b).**
   - **1a — plumbing + Tier-2 shims:** build `repo.transaction` + `TxRepo` + the closure binder (`bindTx`); expose all 24 namespaces. The already-`ClientLike` Tier-2 modules (`entities, facts, proseKernels, relationships, entityHierarchy, statBlocks`) wire as genuine delegating shims (`repo.entities.insert` → `entities.insert(c, …)`). Land the lint rule as **warning**.
   - **1b — Tier-1 client-bindable bodies:** the Tier-1 pool-bound namespaces (`worlds, campaigns, credits, characters, characterConcepts`) have **no client-passed variant today**, so the adapter-shim cannot deliver a working `tx.worlds.setStatus` by delegation — there is nothing to delegate to. The tx-site footprint methods (`worlds.setStatus`/`insertGenerating`, `campaigns.insertSetup`, `credits.grantInTx`/`getWorldGenBalance`, `characters.replaceSubTables`, the concept status writers) are authored as real binder methods here — **new code, not a veneer.** Foundation is done when `repo.transaction` works for the entire tx-site footprint, **verified by a concurrency smoke** (two parallel creates contending on the advisory lock) *before* any consumer migrates.
2. **Cluster + leaf migration (the parallelizable phase).** Migrate each cluster as a unit and each leaf namespace independently: move method bodies into the repo module, migrate consumers off Tier 2 / Tier 3, absorb inline SQL, add/port tests, flip the lint rule to **error** for the cleared directories (same PR as the last migration in that directory). **A transaction site migrates atomically** — all N of its tables convert to `tx.X` in one commit, never one table at a time. An interim **mixed-scope guard** (a scope holding both a `tx.`/`repo.transaction` call *and* a raw `client.query`/`pool.connect` — the split-connection signature) catches partial conversions, and `executeCreateTransaction` + the credit-ledger paths get **concurrency tests**, not just commit/rollback unit tests. Parallelize across leaf namespaces and across the non-tx pure-read namespaces *within* a cluster — **never across a cluster's tx members.**
3. **Teardown.** Delete the now-unused standalone module exports + shims. Flip the lint rule to error globally. Final full-suite + staging-smoke verification.

The transaction sites (§6) are the correctness-critical cases (credit ledger, billing webhook, the 5–7 table writes) and carry the cluster's atomicity + concurrency-test burden.

## Testing strategy

- **`repo.transaction` primitive (foundation, before any consumer migrates):** unit tests for commit / rollback-on-throw / the `repo.ROLLBACK` no-op-discard sentinel / the return-value-after-commit contract / a `tx`-used-after-settled call throwing; an opts test asserting `SHOW lock_timeout` and `SHOW transaction_isolation` *inside* the callback return the requested values; and a **concurrency smoke** (two parallel `executeCreateTransaction`-shaped creates contending on the advisory lock) proving connection-ownership before the risky sites depend on it.
- **Per-namespace / per-cluster:** the existing repo test conventions (`createTestPool` + scoped fixtures, integration against `mythrun_test`). Methods tested through the repo surface. Transaction sites additionally get concurrency tests.
- **The lint rule:** fixture tests — a banned `pool.query` fixture fails; an allowlisted `repo/` file passes; **plus one fixture per documented-caught evasion** (destructure, alias, dynamic `pg` import, helper-in-`repo/`, `.add` inside a `repo.transaction` callback) — same pattern as the Stripe rule's `__tests__/fixtures/banned.fixture.mjs`.
- **Regression:** full `pnpm typecheck && lint && test:coverage` per migration PR; the MYT-55 staging prep-pipeline smoke after the world-gen / character clusters migrate (they're the transaction-heavy ones).

## Out of scope

- The conceptually-blocked namespace work waiting on session-runtime/gameplay (session messages/participants, snapshots, sessionPreps, srd, per-character visibility) — those land with their consumers, now correctly via `repo.X`.
- Any change to query *behavior* — this is a pure access-layer refactor; SQL semantics (filters, lock orders, the enforced-ignorance projection) are preserved verbatim.

## Appendix: audit artifact

`tmp/data-layer-audit-2026-05-30.json` — 344 sites across 9 areas, each with `{file, symbol, tier, table, verb, transactional, currentShape, proposedRepoMethod, notes}`, plus the synthesis (namespace surface, transaction catalog, lint scope). This is the per-site work-list the implementation plan decomposes into beads.
