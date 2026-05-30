// ESLint rule: no-raw-db-access
//
// Bans raw Postgres access outside the repo/db layer. Every DB read/write
// must go through the `repo.X` namespace surface (or `repo.transaction(tx =>
// …)` for multi-table atomic writes). This is the lint half of the
// data-layer repository unification (spec:
// docs/superpowers/specs/2026-05-30-data-layer-repo-unification-design.md).
//
// What it catches (each clause has its own messageId):
//   - rawQuery / rawConnect:  `pool.query(...)`, `client.query(...)`,
//       `pool.connect()` — a `.query`/`.connect` MemberExpression callee.
//   - destructured:           `const { query } = pool` (then `query(sql)`).
//   - aliased:                `const q = pool.query.bind(pool)` /
//                             `const q = pool.query`.
//   - pgImport:               `import pg from 'pg'`, `import * as pg from 'pg'`,
//                             `const pg = await import('pg')` — *value* imports
//                             only. TYPE-ONLY imports (`import type { Pool }
//                             from 'pg'`, `import { type Pool } from 'pg'`) are
//                             NOT flagged: a type import compiles away and is
//                             not runtime DB access. (The 49 `pg` type imports
//                             across the repo are all legitimate.)
//   - sqlPassThrough:         a function DEFINED INSIDE an allowlisted dir that
//                             takes (clientParam, sqlParam, …) and forwards the
//                             SQL param straight to `clientParam.query(sqlParam)`.
//                             This is the laundering hole — the allowlist would
//                             otherwise bless a "raw query" escape hatch living
//                             in repo/. Most important clause; only meaningful
//                             inside the allowlist.
//   - rawTxControl:           `'BEGIN'` / `'COMMIT'` / `'ROLLBACK'` /
//                             `'SET LOCAL …'` string (or template) literals
//                             outside the allowlist — hand-managed transaction
//                             control belongs to repo.transaction.
//   - sideEffectInTx:         a queue-like `queue.add(` (receiver name matches
//                             /queue/i) OR a broad `.publish(` / `.emit(`
//                             lexically inside a `repo.transaction(async (tx)
//                             => { … })` callback body (the MYT-56 shape).
//                             Enqueues / SSE publishes must run AFTER the
//                             transaction resolves, using its return value. The
//                             `.add` arm is queue-narrowed so a `Set.add` /
//                             `Map`-style accumulator inside the callback is
//                             fine. Does NOT fire OUTSIDE a transaction callback.
//
// Path-aware: a per-file allowlist (read from `context.filename` INSIDE the
// rule — new logic the path-agnostic Stripe tripwires lack) fully exempts the
// repo/db layer + the boot entrypoints that legitimately own a pool. The
// `sqlPassThrough` clause is the one check that fires ONLY inside the
// allowlist (laundering hides where raw access is blessed).
//
// Tripwire, NOT a wall — documented residual evasions the rule does NOT catch:
//   - computed member access:        pool['query'](sql)
//   - re-export of a pg client under a new name, then `.query` on the alias in
//     a file that never named `pool`/`client`
//   - SQL built via String.raw / a tagged template assembled elsewhere
//   - an indirect side-effect call inside a tx callback (a helper that enqueues)
//   - a queue variable NOT named /queue/i (e.g. `bull`, `q`) escaping the
//     queue-narrowed `.add` arm of sideEffectInTx (code-review item)
//   - the enforced-ignorance getSnapshotSummary→getById collapse (both are repo
//     methods, no raw SQL — the type system + all-access-through-repo
//     discipline are the real guards there, not this rule)
// Inverse residual false-fires (acknowledged, both unlikely):
//   - a Set/Map-style accumulator variable named with /queue/i (e.g. `queueSet`)
//     would trip the `.add` arm inside a tx callback
//   - the rawTxControl matcher is SQL-shaped (keyword + `;`/EOS, or `SET LOCAL
//     <ident> = …`), so prose like `'Begin your journey'` / `'COMMIT the
//     change'` does NOT fire; a contrived literal that is byte-for-byte a bare
//     tx-control statement (`'BEGIN'`, `'COMMIT;'`) still fires by design
// The sqlPassThrough + sideEffectInTx + rawTxControl clauses are heuristic
// (source-text / shallow-AST), matching the literal shapes that caused the
// MYT-55/56 incidents — not full dataflow analysis.

const path = require('node:path')

// Directories (trailing '/') are prefix/substring matches; bare files match by
// suffix. Allowlisted files are fully exempt from the call/import/destructure/
// alias/tx-control clauses (and are the ONLY place sqlPassThrough fires).
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

function isAllowed(filename) {
  if (!filename) return false
  const norm = filename.split(path.sep).join('/')
  return ALLOW.some((a) => (a.endsWith('/') ? norm.includes(a) : norm.endsWith(a)))
}

// Hand-managed transaction control, shaped to match SQL statements and NOT
// prose (Mythrun is prose-heavy; a future UI/narrative literal must not become
// a hard error at the error-flip). A real tx-control literal is the bare
// statement: `BEGIN` / `COMMIT` / `ROLLBACK` optionally followed by `;` or
// end-of-string, or `SET LOCAL <ident> = …`. Prose like "Begin your journey" /
// "COMMIT the change" continues with an English word and does NOT match.
const TX_CONTROL =
  /^\s*((?:BEGIN|COMMIT|ROLLBACK)\s*(?:;|$)|SET\s+LOCAL\s+[A-Za-z_][\w.]*\s*(?:=|TO\b))/i

// A queue-like receiver name: BullMQ queues are conventionally `queue` /
// `*Queue` / `*queue*`. The `.add` side-effect arm fires only on these, so a
// benign `Set.add` / `Map`-style accumulator (which cluster tx callbacks
// legitimately use) does NOT false-fire.
const QUEUE_RECEIVER = /queue/i

// A pg value import is one whose declaration is NOT type-only AND that brings in
// at least one value (non-type) binding. `import type ... from 'pg'` and
// `import { type Pool } from 'pg'` are pure type imports — skipped.
function isPgValueImport(node) {
  if (node.source.value !== 'pg') return false
  if (node.importKind === 'type') return false
  // No specifiers at all → side-effect import `import 'pg'` (a value import).
  if (node.specifiers.length === 0) return true
  // At least one specifier is a value binding (not `type`-flagged).
  return node.specifiers.some((s) => s.importKind !== 'type')
}

// Walk an AST subtree, invoking `visit` on every node. Cheap hand-rolled
// traversal so the side-effect check can inspect the callback's CallExpressions
// structurally (not via source-text grep) — distinguishing `queue.add(...)`
// from `seen.add(...)` by the callee's receiver Identifier.
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visit)
    } else if (child && typeof child.type === 'string') {
      walk(child, visit)
    }
  }
}

// Is `node` a side-effect call that must not sit inside a repo.transaction
// callback? `.publish(` / `.emit(` are broad (genuine side-effects regardless
// of receiver). `.add(` fires only when the receiver Identifier looks like a
// queue (see QUEUE_RECEIVER) — the MYT-56 target is `queue.add`, not Set/Map.
function isBannedSideEffectCall(node) {
  if (node.type !== 'CallExpression') return false
  const callee = node.callee
  if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return false
  const method = callee.property.name
  if (method === 'publish' || method === 'emit') return true
  if (method === 'add') {
    const obj = callee.object
    return obj.type === 'Identifier' && QUEUE_RECEIVER.test(obj.name)
  }
  return false
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban raw DB access (pool/client query/connect, pg value-import, hand-managed tx control, in-tx side-effects) outside the repo/db layer.',
    },
    schema: [],
    messages: {
      rawQuery:
        'Raw .query() is forbidden outside the repo/db layer. Use repo.X / repo.transaction (data-layer unification).',
      rawConnect:
        'Raw .connect() is forbidden outside the repo/db layer. Use repo.transaction for multi-statement work.',
      destructured:
        'Destructuring .query/.connect off a pg client is forbidden outside the repo/db layer — use repo.X.',
      aliased:
        'Aliasing .query/.connect (e.g. via .bind or assignment) is forbidden outside the repo/db layer — use repo.X.',
      pgImport:
        "Value-importing 'pg' is forbidden outside the repo/db layer. (Type-only `import type` is fine.) Use the repo surface.",
      sqlPassThrough:
        'A SQL-string pass-through helper (forwards a param straight to .query) launders raw DB access through the allowlisted dir — forbidden. Author a named repo method with verbatim SQL instead.',
      rawTxControl:
        'Hand-managed BEGIN/COMMIT/ROLLBACK/SET LOCAL is forbidden outside the repo/db layer. Use repo.transaction(tx => …).',
      sideEffectInTx:
        'Side-effects (.add/.publish/.emit) inside a repo.transaction callback are forbidden (MYT-56). Move them after the transaction resolves, using its return value.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    const allowed = isAllowed(filename)
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    return {
      // .query / .connect member-expression callee (pool.query, client.query,
      // pool.connect). Skipped entirely in allowlisted files.
      'CallExpression > MemberExpression.callee'(node) {
        if (allowed) return
        if (
          node.property.type === 'Identifier' &&
          (node.property.name === 'query' || node.property.name === 'connect')
        ) {
          context.report({
            node,
            messageId: node.property.name === 'query' ? 'rawQuery' : 'rawConnect',
          })
        }
      },

      // import pg from 'pg' / import * as pg from 'pg' / import 'pg' — VALUE
      // imports only (type-only imports compile away, not runtime DB access).
      ImportDeclaration(node) {
        if (allowed) return
        if (isPgValueImport(node)) {
          context.report({ node, messageId: 'pgImport' })
        }
      },
      // const pg = await import('pg')  (dynamic value import)
      'ImportExpression[source.value="pg"]'(node) {
        if (allowed) return
        context.report({ node, messageId: 'pgImport' })
      },

      VariableDeclarator(node) {
        if (allowed) return
        // destructure: const { query } = pool  /  const { connect } = pool
        if (
          node.id.type === 'ObjectPattern' &&
          node.id.properties.some(
            (p) =>
              p.type === 'Property' &&
              p.key.type === 'Identifier' &&
              (p.key.name === 'query' || p.key.name === 'connect'),
          )
        ) {
          context.report({ node, messageId: 'destructured' })
          return
        }
        // alias: const q = pool.query  /  const q = pool.query.bind(pool)
        let init = node.init
        // unwrap `.bind(...)` → inspect the inner `pool.query`
        if (
          init &&
          init.type === 'CallExpression' &&
          init.callee.type === 'MemberExpression' &&
          init.callee.property.type === 'Identifier' &&
          init.callee.property.name === 'bind'
        ) {
          init = init.callee.object
        }
        if (
          init &&
          init.type === 'MemberExpression' &&
          init.property.type === 'Identifier' &&
          (init.property.name === 'query' || init.property.name === 'connect')
        ) {
          context.report({ node, messageId: 'aliased' })
        }
      },

      // SQL-string pass-through helper, ONLY inside the allowlist (the
      // laundering hole). A fn taking >=2 identifier params where the first
      // param is the client and a later param is forwarded straight into
      // `<clientParam>.query(<sqlParam>`.
      'FunctionDeclaration, FunctionExpression, ArrowFunctionExpression'(node) {
        if (!allowed) return
        const params = node.params
          .map((p) => (p.type === 'Identifier' ? p.name : null))
          .filter((n) => n !== null)
        if (params.length < 2) return
        const clientParam = params[0]
        const otherParams = params.slice(1)
        const src = sourceCode.getText(node)
        const forwards = otherParams.some((sqlParam) =>
          new RegExp(`\\b${clientParam}\\s*\\.\\s*query\\s*\\(\\s*${sqlParam}\\b`).test(src),
        )
        if (forwards) {
          context.report({ node, messageId: 'sqlPassThrough' })
        }
      },

      // Hand-managed BEGIN/COMMIT/ROLLBACK/SET LOCAL string literals outside
      // the allowlist (string + template-literal forms).
      Literal(node) {
        if (allowed) return
        if (typeof node.value === 'string' && TX_CONTROL.test(node.value)) {
          context.report({ node, messageId: 'rawTxControl' })
        }
      },
      TemplateElement(node) {
        if (allowed) return
        const raw = node.value?.cooked ?? node.value?.raw
        if (typeof raw === 'string' && TX_CONTROL.test(raw)) {
          context.report({ node, messageId: 'rawTxControl' })
        }
      },

      // Side-effect (queue.add / .publish / .emit) lexically inside a
      // repo.transaction(async (tx) => { … }) callback. Fires once per
      // offending callback. Walks the callback subtree structurally so a
      // `queue.add(...)` is distinguished from a benign `seen.add(...)` /
      // `map.set(...)` accumulator. Does NOT fire outside a transaction callback.
      "CallExpression[callee.property.name='transaction'][callee.object.name='repo']"(node) {
        const cb = node.arguments.find(
          (a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression',
        )
        if (!cb) return
        let found = false
        walk(cb.body, (n) => {
          if (!found && isBannedSideEffectCall(n)) found = true
        })
        if (found) {
          context.report({ node: cb, messageId: 'sideEffectInTx' })
        }
      },
    }
  },
}
