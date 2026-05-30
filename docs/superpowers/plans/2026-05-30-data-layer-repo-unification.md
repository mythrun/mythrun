# Data-Layer Repository Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all backend Postgres access behind a single `repo.X` namespace surface with a `repo.transaction(tx => …)` callback primitive, and add an ESLint rule that makes raw DB access a build failure.

**Architecture:** Each composable namespace is authored once as a closure *binder* over `ClientLike`; `createRepo(pool)` binds the pool, `repo.transaction` binds an in-flight tx client. Self-managing methods (advisory-lock / lock-order-sensitive paths) stay pool-only. Migration is **cluster-based** (the connected component of namespaces sharing a transaction), continuously green via adapter-shims, with an enforced-ignorance type split and a path-aware lint rule.

**Tech Stack:** Node 24, TypeScript strict, `pg`, Vitest, ESLint flat config (`mythrun` local plugin), Postgres (`mythrun_test` integration DB).

**Source of truth:**
- Spec: `docs/superpowers/specs/2026-05-30-data-layer-repo-unification-design.md`
- Per-site work-list: `tmp/data-layer-audit-2026-05-30.json` (344 sites, each `{file, symbol, tier, table, verb, transactional, currentShape, proposedRepoMethod, notes}`). **This plan details the Foundation in full and gives a complete, repeatable per-site recipe for the clusters; the audit JSON is the literal site checklist each cluster task iterates.**

**Standing rules (from CLAUDE.md + memory):** TDD — failing test before implementation. `pnpm typecheck && lint && test` before any task is "done". All subagents use Opus. Implementer subagents do NOT `git add`/`commit`/`push` — the controller stages + commits each task's files serially. Batch commits; push once per phase. Never hardcode model names. Enforced ignorance is a hard boundary.

---

## File structure

**New files (Foundation):**
- `backend/src/repo/_client.ts` — the `ROLLBACK` sentinel + settling-client guard + `withTransactionWithOpts`/`runTransaction` mechanics. (Keeps `repo/index.ts` small.)
- `backend/eslint-rules/no-raw-db-access.cjs` — the lint rule.
- `backend/eslint-rules/__tests__/no-raw-db-access.test.cjs` — RuleTester fixtures (one per caught case).
- `backend/src/repo/__tests__/transaction.int.test.ts` — primitive integration tests (commit / rollback / sentinel / settled-guard / SET LOCAL / concurrency).

**Modified files (Foundation):**
- `backend/src/db/transaction.ts` — add `TxOpts` + `beginPrelude` (export; reused by `_client.ts`).
- `backend/src/repo/index.ts` — `bindTx`, `createRepo` extension to all namespaces, `repo.transaction`, `TxRepo`/`Repo` types.
- `backend/src/repo/_types.ts` — add `TxOpts` re-export if needed (keep `ClientLike` as-is).
- Each existing namespace factory (`worlds.ts`, `campaigns.ts`, `credits.ts`, `characters.ts`, `character-concepts.ts`, `users.ts`, `sessions.ts`, `invites.ts`) — refactor `create*Repo(pool)` into a `*Ns(client: ClientLike)` binder + a thin `create*Repo(pool)` wrapper that adds self-managing methods.
- `eslint.config.js` — register `mythrun/no-raw-db-access` as **warn**; add the per-file allowlist override.

**Per-cluster (Phase 2):** the consumer files named in the audit's `transactionSites` + the namespace modules; the standalone Tier-2 modules become shims then get deleted in teardown.

---

## Phase 1 — Foundation

The Foundation is the lockable contract every later task builds on. It is NOT parallelizable; complete and verify 1a → 1b before any cluster work.

### Task 1: `repo.transaction` mechanics — `_client.ts`

**Files:**
- Create: `backend/src/repo/_client.ts`
- Modify: `backend/src/db/transaction.ts`
- Test: `backend/src/repo/__tests__/transaction.int.test.ts`

- [ ] **Step 1: Add `TxOpts` + `beginPrelude` to `db/transaction.ts`**

```ts
// backend/src/db/transaction.ts — append below withTransaction

export interface TxOpts {
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  lockTimeoutMs?: number
  statementTimeoutMs?: number
}

// Build the `BEGIN; SET LOCAL …` prelude as ONE simple-query batch. SET LOCAL
// must follow BEGIN inside the same transaction (a SET LOCAL with no active tx
// is a silent no-op). isolation defaults to 'read committed' — every current
// call site pins it explicitly; never inherit the connection/RDS default.
export function beginPrelude(opts?: TxOpts): string {
  const isolation = opts?.isolation ?? 'read committed'
  const parts = ['BEGIN', `SET LOCAL transaction_isolation = '${isolation}'`]
  if (opts?.lockTimeoutMs !== undefined) {
    parts.push(`SET LOCAL lock_timeout = '${String(opts.lockTimeoutMs)}ms'`)
  }
  if (opts?.statementTimeoutMs !== undefined) {
    parts.push(`SET LOCAL statement_timeout = '${String(opts.statementTimeoutMs)}ms'`)
  }
  return parts.join(';\n') + ';'
}
```

- [ ] **Step 2: Write the failing primitive test (commit + rollback)**

```ts
// backend/src/repo/__tests__/transaction.int.test.ts
import { describe, it, expect } from 'vitest'
import { createTestPool } from '../../__tests__/_helpers/test-pool.js' // existing helper
import { createRepo, ROLLBACK } from '../index.js'

describe('repo.transaction', () => {
  it('commits writes from the callback', async () => {
    const pool = createTestPool()
    const repo = createRepo(pool)
    const userId = await seedUser(pool) // helper: insert a users row, return id
    await repo.transaction(async (tx) => {
      await tx.credits.grantInTx({ userId, creditType: 'world_gen', amount: 5, sourceType: 'gift' })
    })
    expect(await repo.credits.getWorldGenBalance(userId)).toBe(5)
    await pool.end()
  })

  it('rolls back all writes when the callback throws', async () => {
    const pool = createTestPool()
    const repo = createRepo(pool)
    const userId = await seedUser(pool)
    await expect(repo.transaction(async (tx) => {
      await tx.credits.grantInTx({ userId, creditType: 'world_gen', amount: 5, sourceType: 'gift' })
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await repo.credits.getWorldGenBalance(userId)).toBe(0)
    await pool.end()
  })
})
```

- [ ] **Step 3: Run it — expect FAIL** (`ROLLBACK` / `repo.transaction` not exported yet)

Run: `pnpm vitest run backend/src/repo/__tests__/transaction.int.test.ts`
Expected: FAIL — `ROLLBACK` is not exported / `repo.transaction is not a function`.

- [ ] **Step 4: Implement `_client.ts`**

```ts
// backend/src/repo/_client.ts
import type { Pool, PoolClient } from 'pg'
import { beginPrelude, type TxOpts } from '../db/transaction.js'
import type { ClientLike } from './_types.js'

// Returned by a callback that wants the transaction rolled back WITHOUT
// surfacing an error (Stripe duplicate-redelivery / unknown-event paths).
export const ROLLBACK = Symbol('repo.ROLLBACK')
export type RollbackSignal = typeof ROLLBACK

// Wrap the live PoolClient so any tx.X method called AFTER the transaction
// settles throws a located error instead of corrupting a recycled connection.
function makeSettlingClient(client: PoolClient): { client: ClientLike; settle: () => void } {
  let settled = false
  return {
    client: {
      query: (text, values) => {
        if (settled) {
          throw new Error(
            'tx repo used after the transaction settled — post-tx recovery/branch ' +
              'logic must use the pool-bound repo.X, never a captured tx.',
          )
        }
        return client.query(text, values)
      },
    },
    settle: () => {
      settled = true
    },
  }
}

// The full transaction dance: connect → BEGIN(+SET LOCAL) → fn(boundClient) →
// COMMIT (or ROLLBACK on throw / on ROLLBACK sentinel) → settle → release.
// `bind` turns the per-tx ClientLike into the TxRepo surface.
export async function runTransaction<TxR, T>(
  pool: Pool,
  bind: (c: ClientLike) => TxR,
  fn: (tx: TxR) => Promise<T | RollbackSignal>,
  opts: TxOpts | undefined,
): Promise<T | RollbackSignal> {
  const rawClient = await pool.connect()
  const { client, settle } = makeSettlingClient(rawClient)
  try {
    await rawClient.query(beginPrelude(opts))
    let result: T | RollbackSignal
    try {
      result = await fn(bind(client))
    } catch (err) {
      try {
        await rawClient.query('ROLLBACK')
      } catch {
        /* swallow secondary ROLLBACK error so the original throw surfaces */
      }
      settle()
      throw err
    }
    if (result === ROLLBACK) {
      await rawClient.query('ROLLBACK')
      settle()
      return ROLLBACK
    }
    await rawClient.query('COMMIT')
    settle()
    return result
  } finally {
    rawClient.release()
  }
}
```

- [ ] **Step 5: Implement `bindTx` + `repo.transaction` in `repo/index.ts`** (see Task 2 for the binder; transaction wiring lands here)

```ts
// backend/src/repo/index.ts — shape (full binder in Task 2)
import { type Pool } from 'pg'
import type { ClientLike } from './_types.js'
import type { TxOpts } from './db/transaction.js'
import { runTransaction, ROLLBACK, type RollbackSignal } from './_client.js'
export { ROLLBACK, type RollbackSignal } from './_client.js'

const bindTx = (c: ClientLike) => ({
  // composable namespaces only — filled in Task 2
})

export type TxRepo = ReturnType<typeof bindTx>

export function createRepo(pool: Pool) {
  const base = bindTx(pool)
  return {
    ...base,
    // self-managing augmentation added in Task 2
    transaction: <T>(
      fn: (tx: TxRepo) => Promise<T | RollbackSignal>,
      opts?: TxOpts,
    ): Promise<T | RollbackSignal> => runTransaction(pool, bindTx, fn, opts),
  }
}

export type Repo = ReturnType<typeof createRepo>
```

- [ ] **Step 6: Run the commit/rollback tests — expect PASS**

Run: `pnpm vitest run backend/src/repo/__tests__/transaction.int.test.ts`
Expected: PASS (after Task 2's `bindTx` exists; if running Task 1 standalone, stub `credits` in `bindTx` first).

- [ ] **Step 7: Commit** — `git add backend/src/db/transaction.ts backend/src/repo/_client.ts backend/src/repo/__tests__/transaction.int.test.ts && git commit -m "feat(repo): repo.transaction mechanics — settling client, ROLLBACK sentinel, SET LOCAL prelude"`

### Task 2: The binder — refactor namespace factories into `ClientLike` binders

**Files:**
- Modify: `backend/src/repo/{worlds,campaigns,credits,characters,character-concepts,users,sessions,invites}.ts`
- Modify: `backend/src/repo/index.ts`

- [ ] **Step 1: Refactor one factory as the template (`worlds.ts`)**

Current shape is `export function createWorldsRepo(pool: Pool) { return { method: (...) => pool.query(...) } }`. Split into a binder over `ClientLike`:

```ts
// backend/src/repo/worlds.ts
import type { ClientLike } from './_types.js'

export const worldsNs = (c: ClientLike) => ({
  getById: (id: string) => /* c.query('SELECT * FROM worlds WHERE id = $1', [id]) … */,
  // getSnapshotSummary added in Task 6 (enforced-ignorance split)
  // … every existing method, with `pool` replaced by the captured `c`
})

// Back-compat wrapper so existing `createWorldsRepo(pool)` imports keep working
// during migration; deleted in teardown.
export const createWorldsRepo = (pool: import('pg').Pool) => worldsNs(pool)
```

- [ ] **Step 2: Repeat for `campaigns`, `sessions`, `users`** (pure pool→ClientLike rename — no self-managing methods)

- [ ] **Step 3: `credits.ts`, `invites.ts` — split composable vs self-managing**

```ts
// backend/src/repo/credits.ts
export const creditsNs = (c: ClientLike) => ({
  getWorldGenBalance: (userId: string) => /* identical SQL, pool or tx */,
  grantInTx,            // already a standalone (tx: ClientLike, input) — reuse
  recordClawback,       // composable
  // … other composable reads/writes
})

// Self-managing: own pool connection + advisory lock + SET LOCAL. Pool-only.
export const selfManagingCredits = (pool: Pool) => ({
  atomicDebit: /* existing closure body, unchanged */,
  grant:       /* existing pool-bound grant (owns its 3 SET LOCALs) */,
})
// insertAdminGrant stays in credit-grants.ts — NOT here.
```

- [ ] **Step 4: Assemble `bindTx` + self-managing in `index.ts`**

```ts
const bindTx = (c: ClientLike) => ({
  users: usersNs(c),
  worlds: worldsNs(c),
  campaigns: campaignsNs(c),
  sessions: sessionsNs(c),
  credits: creditsNs(c),
  invites: invitesNs(c),
  characters: charactersNs(c),
  characterConcepts: characterConceptsNs(c),
})

export type TxRepo = ReturnType<typeof bindTx>

export function createRepo(pool: Pool) {
  const base = bindTx(pool)
  return {
    ...base,
    credits: { ...base.credits, ...selfManagingCredits(pool) },
    invites: { ...base.invites, ...selfManagingInvites(pool) },
    users: { ...base.users, getByCognitoSubWithTimeout: makeGetByCognitoSubWithTimeout(pool) },
    transaction: <T>(fn, opts?: TxOpts) => runTransaction(pool, bindTx, fn, opts),
  }
}
export type Repo = ReturnType<typeof createRepo>
```

- [ ] **Step 5: `pnpm typecheck` — expect PASS** (every existing consumer of `repo.X` still compiles; `createRepo` returns a superset)

Run: `pnpm typecheck`
Expected: no errors. If a consumer typed against the old `Repo` shape breaks, it is because a method moved namespaces — fix the call site.

- [ ] **Step 6: `pnpm test` — expect PASS** (no behavior change; SQL is verbatim)

- [ ] **Step 7: Commit** — `git add backend/src/repo && git commit -m "refactor(repo): factories → ClientLike binders; bindTx + TxRepo; self-managing split"`

### Task 3: Settled-guard + ROLLBACK-sentinel + SET LOCAL tests

**Files:** Test: `backend/src/repo/__tests__/transaction.int.test.ts`

- [ ] **Step 1: Add the three behavior tests**

```ts
it('returns the ROLLBACK sentinel and commits nothing on no-op discard', async () => {
  const pool = createTestPool(); const repo = createRepo(pool); const userId = await seedUser(pool)
  const out = await repo.transaction(async (tx) => {
    await tx.credits.grantInTx({ userId, creditType: 'world_gen', amount: 5, sourceType: 'gift' })
    return ROLLBACK
  })
  expect(out).toBe(ROLLBACK)
  expect(await repo.credits.getWorldGenBalance(userId)).toBe(0)
  await pool.end()
})

it('throws if a captured tx is used after the transaction settles', async () => {
  const pool = createTestPool(); const repo = createRepo(pool); const userId = await seedUser(pool)
  let captured: any
  await repo.transaction(async (tx) => { captured = tx })
  await expect(captured.credits.getWorldGenBalance(userId)).rejects.toThrow(/after the transaction settled/)
  await pool.end()
})

it('applies opts as SET LOCAL inside the callback', async () => {
  const pool = createTestPool(); const repo = createRepo(pool)
  await repo.transaction(async (tx) => {
    const lock = await tx.__raw('SHOW lock_timeout')        // test-only escape; or assert via a probe method
    const iso = await tx.__raw('SHOW transaction_isolation')
    expect(lock).toBe('2s'); expect(iso).toBe('serializable')
  }, { lockTimeoutMs: 2000, isolation: 'serializable' })
  await pool.end()
})
```

> If exposing `tx.__raw` is undesirable, assert SET LOCAL via a dedicated `settings.showGuc(name)` composable method instead (`SELECT current_setting($1)`). Pick one and keep it; do not leave both.

- [ ] **Step 2: Run — expect FAIL then implement → PASS.** The sentinel + settled-guard are already in `_client.ts` (Task 1); the SET LOCAL assertion drives whichever probe method you chose.

- [ ] **Step 3: Commit** — `git add backend/src/repo && git commit -m "test(repo): ROLLBACK sentinel, settled-guard, SET LOCAL opts"`

### Task 4: The lint rule (warn) + fixtures

**Files:**
- Create: `backend/eslint-rules/no-raw-db-access.cjs`, `backend/eslint-rules/__tests__/no-raw-db-access.test.cjs`
- Modify: `eslint.config.js`

- [ ] **Step 1: Write the RuleTester fixtures FIRST (failing — rule doesn't exist)**

```cjs
// backend/eslint-rules/__tests__/no-raw-db-access.test.cjs
const { RuleTester } = require('eslint')
const rule = require('../no-raw-db-access.cjs')
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } })

tester.run('no-raw-db-access', rule, {
  valid: [
    'repo.worlds.getById(id)',
    'await repo.transaction(async (tx) => { await tx.worlds.insertGenerating(w) })',
    'logger.info({ x }, "msg")', // .info is not a banned member
  ],
  invalid: [
    { code: 'pool.query("SELECT 1")', errors: [{ messageId: 'rawQuery' }] },
    { code: 'client.connect()', errors: [{ messageId: 'rawConnect' }] },
    { code: 'const { query } = pool; query("x")', errors: [{ messageId: 'destructured' }] },
    { code: 'const q = pool.query.bind(pool)', errors: [{ messageId: 'aliased' }] },
    { code: 'import pg from "pg"', errors: [{ messageId: 'pgImport' }] },
    { code: 'const pg = await import("pg")', errors: [{ messageId: 'pgImport' }] },
    { code: 'function raw(p, sql) { return p.query(sql) }', errors: [{ messageId: 'sqlPassThrough' }] },
    {
      code: 'await repo.transaction(async (tx) => { await queue.add("x", {}) })',
      errors: [{ messageId: 'sideEffectInTx' }],
    },
  ],
})
console.log('no-raw-db-access: all RuleTester cases passed')
```

- [ ] **Step 2: Implement the rule** (modeled on `no-stripe-price-mutations.cjs`, plus path-aware allowlist + the evasion clauses)

```cjs
// backend/eslint-rules/no-raw-db-access.cjs
// Bans raw DB access outside the repo layer. Tripwire, NOT a wall — the type
// system + all-access-through-repo discipline are the real guards.
// Documented residual evasions: computed member access pool['query'](...),
// re-export of a pg client under a new name, SQL built via String.raw.
const path = require('node:path')

const ALLOW = [
  'backend/src/repo/',
  'backend/src/db/migrate.ts',
  'backend/src/db/transaction.ts',
  'backend/src/db/postgres.ts',
  'backend/src/boot/migrations-current.ts',
  'backend/src/server.ts',
  'backend/src/worker.ts',
  'backend/src/worker/health-server.ts',
]
const isAllowed = (filename) => {
  const norm = filename.split(path.sep).join('/')
  return ALLOW.some((a) => (a.endsWith('/') ? norm.includes(a) : norm.endsWith(a)))
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Ban raw DB access (pool/client query/connect, pg import) outside the repo layer.' },
    schema: [],
    messages: {
      rawQuery: 'Raw .query() is forbidden outside repo/. Use repo.X / repo.transaction.',
      rawConnect: 'Raw .connect() is forbidden outside repo/. Use repo.transaction.',
      destructured: 'Destructuring .query/.connect off a pg client is forbidden — use repo.X.',
      aliased: 'Aliasing .query/.connect (e.g. .bind) is forbidden — use repo.X.',
      pgImport: "Importing 'pg' is forbidden outside the repo/db layer.",
      sqlPassThrough: 'A SQL-string pass-through helper in an allowlisted dir launders raw access — forbidden.',
      sideEffectInTx: 'Side-effects (.add/.publish/.emit) inside a repo.transaction callback are forbidden (MYT-56). Move after commit using the return value.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    const allowed = isAllowed(filename)
    return {
      // .query / .connect member calls (skip in allowlisted files)
      'CallExpression > MemberExpression.callee'(node) {
        if (allowed) return
        if (node.property.type === 'Identifier' && (node.property.name === 'query' || node.property.name === 'connect')) {
          context.report({ node, messageId: node.property.name === 'query' ? 'rawQuery' : 'rawConnect' })
        }
      },
      // import 'pg' (static + dynamic) outside allowlist
      ImportDeclaration(node) {
        if (!allowed && node.source.value === 'pg') context.report({ node, messageId: 'pgImport' })
      },
      'ImportExpression[source.value="pg"]'(node) {
        if (!allowed) context.report({ node, messageId: 'pgImport' })
      },
      // destructure: const { query } = pool
      VariableDeclarator(node) {
        if (allowed) return
        if (node.id.type === 'ObjectPattern' &&
            node.id.properties.some((p) => p.type === 'Property' && p.key.type === 'Identifier' && (p.key.name === 'query' || p.key.name === 'connect'))) {
          context.report({ node, messageId: 'destructured' })
        }
        // alias: const q = pool.query.bind(pool) / const q = pool.query
        if (node.init && node.init.type === 'MemberExpression' &&
            node.init.property.type === 'Identifier' && (node.init.property.name === 'query' || node.init.property.name === 'connect')) {
          context.report({ node, messageId: 'aliased' })
        }
      },
      // helper-in-repo/: a fn that takes a param and calls param.query(sqlParam)
      // (only meaningful inside allowlisted dirs — that's where laundering hides)
      'FunctionDeclaration, ArrowFunctionExpression'(node) {
        if (!allowed) return
        const params = node.params.map((p) => (p.type === 'Identifier' ? p.name : null)).filter(Boolean)
        if (params.length < 2) return
        const src = context.sourceCode.getText(node)
        if (new RegExp(`${params[0]}\\.query\\(\\s*${params[1]}`).test(src)) {
          context.report({ node, messageId: 'sqlPassThrough' })
        }
      },
      // side-effect inside repo.transaction callback
      "CallExpression[callee.property.name='transaction'][callee.object.name='repo']"(node) {
        const cb = node.arguments.find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression')
        if (!cb) return
        const body = context.sourceCode.getText(cb)
        if (/\.\s*(add|publish|emit)\s*\(/.test(body)) {
          context.report({ node: cb, messageId: 'sideEffectInTx' })
        }
      },
    }
  },
}
```

> The `sqlPassThrough` and `sideEffectInTx` clauses use source-text regex over the node — pragmatic and matches the literal shapes that caused the incidents. Document in the rule header that they are heuristic (not full dataflow). Implementer: tune the AST selectors against the fixtures until all 8 invalid cases report and the 3 valid cases pass; the exact selector strings above are a starting point, not gospel.

- [ ] **Step 3: Run the rule test — iterate to PASS**

Run: `node backend/eslint-rules/__tests__/no-raw-db-access.test.cjs`
Expected: "no-raw-db-access: all RuleTester cases passed".

- [ ] **Step 4: Wire into `eslint.config.js` as WARN + per-file allowlist note**

```js
const noRawDbAccess = require('./backend/eslint-rules/no-raw-db-access.cjs')
// in plugins.mythrun.rules: 'no-raw-db-access': noRawDbAccess,
// in rules: 'mythrun/no-raw-db-access': 'warn',
```

The allowlist lives INSIDE the rule (reads `context.filename`), so no per-file ESLint override is needed. `pnpm lint` (script: `eslint src --no-error-on-unmatched-pattern`, no `--max-warnings`) stays green while the rule is `warn`.

- [ ] **Step 5: `pnpm lint` — expect green (warnings only)**, `pnpm test` (config-wiring smoke still passes).

- [ ] **Step 6: Commit** — `git add backend/eslint-rules eslint.config.js && git commit -m "feat(lint): no-raw-db-access rule (warn) + fixtures"`

### Task 5: Tier-2 delegating shims (Foundation 1a complete)

**Files:** Modify: `backend/src/repo/index.ts`; the Tier-2 modules (`entities, facts, proseKernels, relationships, entityHierarchy, statBlocks`) are already `ClientLike`-shaped.

- [ ] **Step 1: Add the already-`ClientLike` Tier-2 namespaces to `bindTx`** — they need no refactor; `entitiesNs = (c) => ({ insert: (input) => entities.insert(c, input), … })` wrapping the existing standalone functions.

```ts
// in bindTx:
entities: { insert: (i) => entitiesInsert(c, i), listByWorld: (w) => entitiesListByWorld(c, w), /* … */ },
facts: { insertMany: (rows) => factsInsertMany(c, rows), /* … */ },
// proseKernels, relationships, entityHierarchy, statBlocks similarly
```

- [ ] **Step 2: `pnpm typecheck && lint && test` — expect PASS.** All 24 namespaces now resolve on `repo` and `tx`; nothing migrated off Tier 2 yet (shims delegate).

- [ ] **Step 3: Commit** — `git add backend/src/repo && git commit -m "feat(repo): Tier-2 delegating shims — all 24 namespaces on repo + TxRepo"`

### Task 6: Foundation 1b — Tier-1 client-bindable tx-footprint bodies + enforced-ignorance split + concurrency smoke

**Files:** Modify: `backend/src/repo/{worlds,campaigns,credits,characters,character-concepts}.ts`, `world-snapshot-view.ts`; Test: `transaction.int.test.ts`

- [ ] **Step 1: Author the tx-site-footprint binder methods** that have no client-passed variant today (per the audit's `transactionSites`): `worlds.insertGenerating`/`setStatus`/the concept/vocab/overview/starting-situation column writers; `campaigns.insertSetup`/`renameConditional`; `characters.replaceSubTables`; `characterConcepts` status writers. Each is plain `c.query(...)` with SQL lifted verbatim from the current inline site (cite the audit's `currentShape`).

- [ ] **Step 2: Enforced-ignorance split — create `worlds.getSnapshotSummary`**

Move the allowlist projection (currently inline in `world-snapshot-view.ts`) into `worlds.getSnapshotSummary`, returning `WorldSummary` (the existing type that structurally omits plot columns). `worldSnapshotView.fetch` composes it. Add the prep-tier doc-comment to any plot-column accessor. **Do not** add a full-row read to any Fast-Thinker path.

- [ ] **Step 3: Write the concurrency smoke (failing until 1b methods exist)**

```ts
it('two concurrent advisory-locked creates do not double-spend credits', async () => {
  const pool = createTestPool(); const repo = createRepo(pool)
  const userId = await seedUserWithCredits(pool, 1) // exactly 1 world-gen credit
  const create = () => repo.transaction(async (tx) => {
    await tx.credits.grantInTx(/* … debit-shaped via the real executeCreateTransaction recipe … */)
    // mirrors executeCreateTransaction: advisory lock + balance reread + inserts
  }, { lockTimeoutMs: 5000, statementTimeoutMs: 10000 })
  const results = await Promise.allSettled([create(), create()])
  const ok = results.filter((r) => r.status === 'fulfilled')
  expect(ok).toHaveLength(1) // one wins, one is rejected by the balance reread
  await pool.end()
})
```

- [ ] **Step 4: Implement until the smoke passes.** This proves connection-ownership before any consumer migrates.

- [ ] **Step 5: `pnpm typecheck && lint && test` — PASS. Commit, then `git push` (end of Phase 1).**

---

## Phase 2 — Cluster + leaf migration (parallelizable across clusters/leaves, serial within a cluster's tx members)

**Per-site recipe (applies to every site the audit lists for the cluster):**

1. Find the site by `file` + `symbol` in `tmp/data-layer-audit-2026-05-30.json`.
2. If `transactional: false` (single read/write): replace the inline SQL / Tier-2 call with the `repo.X` method (create the binder method if absent, SQL verbatim from `currentShape`).
3. If `transactional: true`: convert the **entire** hand-managed `pool.connect()/BEGIN…COMMIT` block to `repo.transaction(async (tx) => { … })` in ONE commit — **all N tables at once**, slow I/O (LLM/Stripe) moved before the call, side-effects (queue.add/SSE) moved after using the return value. Never convert one table at a time (split-connection bug).
4. Port/author the test through the repo surface; transaction sites get a concurrency test.
5. `pnpm typecheck && lint && test`. When a directory has zero remaining raw-DB sites, flip its `mythrun/no-raw-db-access` override to `error` **in the same PR**.

**Atomicity guard:** during migration a file must not contain BOTH a `tx.`/`repo.transaction` call AND a raw `client.query`/`pool.connect`. If it does, the conversion is half-done — finish it before committing.

### Task 7: Cluster A — world+campaign create (`worlds, campaigns, credits, pipelineRuns, campaign_members`)

Sites (audit `transactionSites` + area inventory): `executeCreateTransaction`, the 9 world-gen stages, `cost-cap.issueCostCapRefund`, plus all Tier-3 reads in `routes/campaigns.ts` and `llm/prep/`.

- [ ] **Worked example — `executeCreateTransaction`** (the highest-risk site). Current: `pool.connect()` → advisory lock → balance reread → 5 INSERTs → COMMIT → `queue.add`. Target:

```ts
// llm balance peek OUTSIDE
const peek = await repo.credits.getWorldGenBalance(userId)
if (peek < cost) throw new InsufficientCreditsError()
const result = await repo.transaction(async (tx) => {
  await tx.credits.acquireUserCreditLock(userId)          // advisory lock, composable
  const locked = await tx.credits.getWorldGenBalance(userId) // SAME SQL, under lock
  if (locked < cost) throw new InsufficientCreditsError()
  await tx.worlds.insertGenerating(world)
  await tx.campaigns.insertSetup(campaign)
  await tx.campaigns.addMember(ownerMember)
  await tx.credits.grantInTx(debitRow)
  await tx.pipelineRuns.insertSeedRow(seed)
  return { campaignId: campaign.id, worldId: world.id }
}, { lockTimeoutMs: 5000, statementTimeoutMs: 10000 })
await queue.add('world-gen', result)                       // AFTER commit (MYT-56)
```
- [ ] Write a concurrency test (two parallel creates, one wins). Then migrate the 9 world-gen stages (each: reads+LLM outside, `repo.transaction` for the persist; coherence-pass uses this exact shape — no external client). **Keep `markStageCompleted`/`markStageFailed`/`markWorldComplete` + status `UPDATE`s pool-bound (`repo.X`), NOT inside the stage callback** (recovery must persist past a rolled-back stage).
- [ ] Migrate `cost-cap.issueCostCapRefund` and all Cluster-A inline reads. Flip `routes/` (campaigns portions) + `llm/prep/` directories to lint `error` when clear.
- [ ] `pnpm typecheck && lint && test:coverage`; commit per logical site; push at cluster end.

### Task 8: Cluster B — billing (`stripeEvents, billingHistory, credits, userSubscriptions, purchases, users`)

Sites: webhook `dispatchEvent` (6 tables, 3 terminal outcomes), `webhook-refund` (stays self-managing, lock order `users → purchases(id ASC) → billing_history`), `handleRegister` (3-write; 23505 recovery re-fetches on the **pool** after rollback). `findOrCreateStripeCustomer`: Stripe call moves out of repo; `setStripeCustomerId` becomes an idempotent upsert (`ON CONFLICT DO NOTHING RETURNING` + unique constraint on `users.stripe_customer_id` — add the migration).

- [ ] **Worked example — `dispatchEvent`** uses all three outcomes:

```ts
const outcome = await repo.transaction(async (tx) => {
  const fresh = await tx.stripeEvents.recordOrSkip(event.id)
  if (!fresh) return ROLLBACK                     // duplicate redelivery — no error
  if (!isHandled(event.type)) return { kind: 'unknown' } // commits the stripe_events row
  const r = await handle(event, tx)               // grantInTx etc. compose here
  return r
}, { lockTimeoutMs: 1000, statementTimeoutMs: 5000, isolation: 'read committed' })
if (outcome === ROLLBACK) return reply.code(200).send()  // idempotent ack
```
- [ ] `handleRegister`: convert the 3-write block to `repo.transaction`; the 23505 catch arm calls `repo.users.getByCognitoSub` on the **pool** (never the captured tx). `webhook-refund` stays self-managing (do not convert). Add concurrency tests for the credit-ledger paths. Add the `users.stripe_customer_id` unique-constraint migration. Flip `backend/src/billing/` + `routes/users.ts` to lint `error` when clear.
- [ ] `pnpm typecheck && lint && test:coverage`; commit; push at cluster end.

### Task 9: Cluster C — character (`characterConcepts, characters, entities, facts, proseKernels, relationships`)

Sites: `POST /characters` (concept upsert→flip→enqueue), `finalize-character-creation`, character-sheet `persistCharacter` (6 tables), character-integration `writeIntegration` (7 tables).

- [ ] **Worked example — `writeIntegration`**: reads + any LLM outside; one `repo.transaction` writing entities/facts/proseKernels/relationships/characters/characterConcepts/campaigns; the ordered `insertMany`-returns-ids → post-commit `finalizedEvents` publish uses the **return value**. Migrate `persistCharacter`, `POST /characters` (enqueue AFTER commit), `finalize-character-creation`. Flip the character directories to lint `error` when clear.
- [ ] `pnpm typecheck && lint && test:coverage`; commit; push at cluster end.

### Task 10: Leaf namespaces (parallelizable, any order)

`settings` (cost-cap inline reads), `statBlocks`, `worldInventory`, `worldSnapshot` (composes `getSnapshotSummary`), `randomTables`, `sessions`, `entityHierarchy`. Each: migrate its inline/Tier-2 sites per the recipe, port tests, flip its directory to lint `error` when clear.

- [ ] One commit per leaf namespace; `pnpm typecheck && lint && test`; push when the batch is green.

---

## Phase 3 — Teardown

### Task 11: Delete shims, global lint error, final verification

**Files:** the standalone Tier-2 module exports now unused; the `create*Repo` back-compat wrappers; `eslint.config.js`.

- [ ] **Step 1:** Delete the now-unused standalone exports + the `create*Repo(pool)` back-compat wrappers (keep any standalone fn still imported by a binder, e.g. `grantInTx`). `pnpm typecheck` flags every dangling import — fix each.
- [ ] **Step 2:** Flip `mythrun/no-raw-db-access` to `error` globally in `eslint.config.js` (remove per-directory overrides). Keep the in-rule allowlist.
- [ ] **Step 3:** `pnpm typecheck && lint && test:coverage && wiki:check && dev-tool:check` — all green. Run the MYT-55 staging prep-pipeline smoke (`pnpm smoke:prep-pipeline`) — the transaction-heavy world-gen/character paths now go through `repo.transaction`.
- [ ] **Step 4:** Dispatch the wiki-update subagent (AUTHORING.md) — the data-layer page + any `repo.X` references. Commit wiki + code together, then push.

---

## Self-review (against the spec)

- **Spec coverage:** transaction primitive (T1/T3), binder + TxRepo type (T2), two-idiom split (T2), enforced-ignorance `getSnapshotSummary` (T6), lint rule + evasions + fixtures (T4), cluster-based migration with atomic tx-site conversion (T7–T10), foundation 1a/1b split + concurrency smoke (T5/T6), teardown + global lint error (T11). All present.
- **Placeholders:** the per-site bodies in Phase 2 intentionally reference the audit JSON (the spec's stated work-list) rather than transcribing 344 SQL strings; each cluster carries one fully-worked tx site + the exact recipe. The SET-LOCAL probe (T3) names two options and says "pick one" — implementer chooses, no ambiguity left in the tree.
- **Type consistency:** `bindTx`/`TxRepo`/`ROLLBACK`/`runTransaction`/`beginPrelude` names are used identically across T1–T6. `TxRepo = ReturnType<typeof bindTx>` excludes `.transaction` + self-managing by construction.
