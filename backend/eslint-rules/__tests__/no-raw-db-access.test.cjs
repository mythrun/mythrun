const { RuleTester } = require('eslint')
const tseslint = require('typescript-eslint')
const rule = require('../no-raw-db-access.cjs')

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
})

// The default espree parser can't parse TypeScript-only `import type` syntax.
// The two type-import valid cases below use the typescript-eslint parser so the
// rule sees the real `importKind` flags it skips on.
const tsParser = { languageOptions: { parser: tseslint.parser } }

// A consumer-layer path (NOT allowlisted) — the default for invalid cases.
const CONSUMER = 'backend/src/routes/campaigns.ts'
// An allowlisted repo/ path — where the sqlPassThrough laundering clause fires
// and where the raw-access clauses are exempt.
const REPO = 'backend/src/repo/worlds.ts'

tester.run('no-raw-db-access', rule, {
  valid: [
    // Repo-surface reads/writes are the whole point — never flagged.
    { code: 'repo.worlds.getById(id)', filename: CONSUMER },
    {
      code: 'await repo.transaction(async (tx) => { await tx.worlds.insertGenerating(w) })',
      filename: CONSUMER,
    },
    // .info is not a banned member.
    { code: 'logger.info({ x }, "msg")', filename: CONSUMER },
    // queue.add OUTSIDE any repo.transaction callback must NOT fire the
    // side-effect clause (and .add is not query/connect).
    { code: 'await queue.add("world-gen", { id })', filename: CONSUMER },
    // A repo/ file legitimately does raw .query — allowlisted, exempt.
    { code: 'export const f = (c) => c.query("SELECT 1")', filename: REPO },
    // Hand-managed tx control inside the allowlist is fine (repo.transaction
    // mechanics live there).
    { code: 'await c.query("BEGIN")', filename: REPO },
    // Type-only pg imports compile away — not runtime DB access.
    { code: 'import type { Pool } from "pg"', filename: CONSUMER, ...tsParser },
    { code: 'import { type Pool, type PoolClient } from "pg"', filename: CONSUMER, ...tsParser },
    // A 2-param helper in repo/ that does NOT forward its 2nd param to .query
    // is not a pass-through (no laundering).
    { code: 'export const g = (c, id) => c.query("SELECT $1", [id])', filename: REPO },
    // rawTxControl must NOT fire on prose that merely STARTS with a tx-control
    // word mid-sentence — "Begin your journey" is not a BEGIN statement.
    { code: 'const s = "Begin your journey"', filename: CONSUMER },
    { code: 'const s = "Committed to the cause"', filename: CONSUMER },
    // sideEffectInTx must NOT fire on Set/Map accumulators inside the callback —
    // only queue-like receivers (/queue/i). Cluster tx callbacks use these.
    {
      code: 'await repo.transaction(async (tx) => { const seen = new Set(); seen.add(1) })',
      filename: CONSUMER,
    },
    {
      code: 'await repo.transaction(async (tx) => { const m = new Map(); m.set(1, 2) })',
      filename: CONSUMER,
    },
  ],
  invalid: [
    { code: 'pool.query("SELECT 1")', filename: CONSUMER, errors: [{ messageId: 'rawQuery' }] },
    { code: 'client.connect()', filename: CONSUMER, errors: [{ messageId: 'rawConnect' }] },
    {
      code: 'const { query } = pool; query("x")',
      filename: CONSUMER,
      // destructure reports once; the subsequent bare query("x") is a plain
      // CallExpression (no MemberExpression callee) so it does not double-fire.
      errors: [{ messageId: 'destructured' }],
    },
    {
      code: 'const q = pool.query.bind(pool)',
      filename: CONSUMER,
      errors: [{ messageId: 'aliased' }],
    },
    { code: 'const q = pool.query', filename: CONSUMER, errors: [{ messageId: 'aliased' }] },
    { code: 'import pg from "pg"', filename: CONSUMER, errors: [{ messageId: 'pgImport' }] },
    // namespace value import
    { code: 'import * as pg from "pg"', filename: CONSUMER, errors: [{ messageId: 'pgImport' }] },
    // bare side-effect value import (specifiers.length === 0)
    { code: 'import "pg"', filename: CONSUMER, errors: [{ messageId: 'pgImport' }] },
    {
      code: 'const pg = await import("pg")',
      filename: CONSUMER,
      errors: [{ messageId: 'pgImport' }],
    },
    // SQL-string pass-through helper INSIDE an allowlisted dir (laundering).
    {
      code: 'function raw(p, sql) { return p.query(sql) }',
      filename: REPO,
      errors: [{ messageId: 'sqlPassThrough' }],
    },
    // .add inside a repo.transaction callback (MYT-56 shape).
    {
      code: 'await repo.transaction(async (tx) => { await queue.add("x", {}) })',
      filename: CONSUMER,
      errors: [{ messageId: 'sideEffectInTx' }],
    },
    // Hand-managed BEGIN outside the allowlist.
    {
      code: 'await someClient.query("BEGIN")',
      filename: CONSUMER,
      // rawQuery (the .query call) + rawTxControl (the BEGIN literal).
      errors: [{ messageId: 'rawQuery' }, { messageId: 'rawTxControl' }],
    },
    // A bare BEGIN literal still fires rawTxControl after the regex anchoring
    // change (the true-positive path the prose-de-noising must not break).
    { code: 'const s = "BEGIN"', filename: CONSUMER, errors: [{ messageId: 'rawTxControl' }] },
  ],
})

console.log('no-raw-db-access: all RuleTester cases passed')
