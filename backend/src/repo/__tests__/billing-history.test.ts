import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { withTx, pool, ensureSchema } from './_helpers/with-tx.js'
import { resetData } from './_helpers/reset-data.js'
import { createTestUser } from './_helpers/create-test-user.js'
import {
  billingHistory,
  type NewBillingHistoryRow,
  type BillingHistoryKind,
} from '../billing-history.js'
import { uuidv7 } from '../uuidv7.js'

beforeAll(async () => {
  await ensureSchema()
})

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetData(pool)
})

/**
 * Build a NewBillingHistoryRow with sane defaults; tests override only the
 * fields they care about. Mirrors the makeRow helper in user-subscriptions.test.ts.
 *
 * Defaults: kind='purchase' + source_id_stripe='pi_<short-id>' so the
 * prefix-by-kind CHECK is satisfied without each test repeating the pairing.
 */
function makeRow(
  overrides: Partial<NewBillingHistoryRow> & Pick<NewBillingHistoryRow, 'user_id'>,
): NewBillingHistoryRow {
  const kind: BillingHistoryKind = overrides.kind ?? 'purchase'
  const defaultPrefix = kind === 'purchase' ? 'pi_' : kind === 'invoice' ? 'in_' : 're_'
  return {
    id: overrides.id ?? uuidv7(),
    user_id: overrides.user_id,
    kind,
    source_id_stripe: overrides.source_id_stripe ?? `${defaultPrefix}default_${uuidv7().slice(0, 8)}`,
    stripe_payment_intent_id: overrides.stripe_payment_intent_id ?? null,
    lookup_key: overrides.lookup_key ?? null,
    amount_cents: overrides.amount_cents ?? 1000,
    currency: overrides.currency ?? 'usd',
    expires_at: overrides.expires_at ?? null,
    occurred_at: overrides.occurred_at ?? new Date('2026-05-05T12:00:00Z'),
  }
}

describe('repo.billingHistory', () => {
  it('append default semantics: plain INSERT; second insert with same (kind, source_id_stripe) raises 23505', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const sourceId = 'pi_dup_default'
      await billingHistory.append(
        tx,
        makeRow({ user_id: user.id, kind: 'purchase', source_id_stripe: sourceId }),
      )
      // Second insert with the same (kind, source_id_stripe) must throw a
      // unique-violation. Default semantics (no opts) is plain INSERT.
      let caught: unknown
      try {
        await billingHistory.append(
          tx,
          makeRow({ user_id: user.id, kind: 'purchase', source_id_stripe: sourceId }),
        )
      } catch (err) {
        caught = err
      }
      expect(caught).toBeDefined()
      const errCode = (caught as { code?: string }).code
      expect(errCode).toBe('23505')
    })
  })

  it('append with do_nothing returns the existing row id on conflict (no error)', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const sourceId = 'pi_dup_do_nothing'
      const first = await billingHistory.append(
        tx,
        makeRow({ user_id: user.id, kind: 'purchase', source_id_stripe: sourceId }),
        { onConflict: 'do_nothing' },
      )
      // A second call with the same (kind, source_id_stripe) but a fresh id
      // should not error and should return the FIRST row's id (canonical row),
      // proving the repo's follow-up SELECT works after ON CONFLICT DO NOTHING.
      const second = await billingHistory.append(
        tx,
        makeRow({
          user_id: user.id,
          kind: 'purchase',
          source_id_stripe: sourceId,
          id: uuidv7(), // different id; must be ignored
          amount_cents: 9999, // would-be different amount; must be ignored
        }),
        { onConflict: 'do_nothing' },
      )
      expect(second.id).toBe(first.id)
      expect(second.amount_cents).toBe(1000) // first call's value, not 9999
    })
  })

  it('append with do_update_coalesce: COALESCE merges nullable fields (first non-null wins)', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const sourceId = 'in_coalesce_test'
      // First call: expires_at NULL, lookup_key='tier_basic', stripe_payment_intent_id=NULL.
      const first = await billingHistory.append(
        tx,
        makeRow({
          user_id: user.id,
          kind: 'invoice',
          source_id_stripe: sourceId,
          expires_at: null,
          lookup_key: 'tier_basic',
          stripe_payment_intent_id: null,
        }),
        { onConflict: 'do_update_coalesce' },
      )
      expect(first.expires_at).toBeNull()
      expect(first.lookup_key).toBe('tier_basic')
      expect(first.stripe_payment_intent_id).toBeNull()

      // Second call: expires_at non-null (fills NULL), lookup_key='tier_pro'
      // (first non-null wins → 'tier_basic' preserved), stripe_payment_intent_id
      // non-null (fills NULL).
      const newExpiry = new Date('2026-07-01T00:00:00Z')
      const second = await billingHistory.append(
        tx,
        makeRow({
          user_id: user.id,
          kind: 'invoice',
          source_id_stripe: sourceId,
          id: uuidv7(),
          expires_at: newExpiry,
          lookup_key: 'tier_pro',
          stripe_payment_intent_id: 'pi_for_invoice',
        }),
        { onConflict: 'do_update_coalesce' },
      )
      // First-call non-null preserved over second-call non-null (COALESCE
      // takes existing first; "first non-null wins").
      expect(second.lookup_key).toBe('tier_basic')
      // First-call NULLs filled by second-call non-NULLs.
      expect(second.expires_at).not.toBeNull()
      expect(second.expires_at?.toISOString()).toBe(newExpiry.toISOString())
      expect(second.stripe_payment_intent_id).toBe('pi_for_invoice')
      // Canonical row id is the first one (didn't get overwritten by EXCLUDED.id).
      expect(second.id).toBe(first.id)
    })
  })

  it('findBySourceStripeId returns null when no row matches; row when match', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const noMatch = await billingHistory.findBySourceStripeId(tx, 'pi_does_not_exist')
      expect(noMatch).toBeNull()

      const inserted = await billingHistory.append(
        tx,
        makeRow({ user_id: user.id, kind: 'purchase', source_id_stripe: 'pi_findme' }),
      )
      const found = await billingHistory.findBySourceStripeId(tx, 'pi_findme')
      expect(found).not.toBeNull()
      expect(found?.id).toBe(inserted.id)
      expect(found?.kind).toBe('purchase')
      expect(found?.source_id_stripe).toBe('pi_findme')
    })
  })

  it("findInvoiceByPaymentIntent returns null when no kind='invoice' row has the PI; id when match", async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      // No invoice rows yet: not found.
      const empty = await billingHistory.findInvoiceByPaymentIntent(tx, 'pi_unknown')
      expect(empty).toBeNull()

      // A purchase row with stripe_payment_intent_id matching MUST NOT be
      // returned — the method filters to kind='invoice'.
      // (Note: §5.4.5 spec sets kind='purchase'.stripe_payment_intent_id=NULL,
      // but defense-in-depth: even if a purchase row had a PI value,
      // findInvoiceByPaymentIntent must skip it.)
      // We use a true invoice row to test the positive case.
      const pi = 'pi_for_invoice_lookup'
      const insertedInvoice = await billingHistory.append(
        tx,
        makeRow({
          user_id: user.id,
          kind: 'invoice',
          source_id_stripe: 'in_lookup_target',
          stripe_payment_intent_id: pi,
        }),
      )
      const found = await billingHistory.findInvoiceByPaymentIntent(tx, pi)
      expect(found).not.toBeNull()
      expect(found?.id).toBe(insertedInvoice.id)
      expect(found?.kind).toBe('invoice')
    })
  })

  it('listByUser cursor-pagination: 51 rows → page 1 returns 50 + nextCursor; page 2 returns 1 + null', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      // Insert 51 rows for the user with strictly distinct occurred_at values
      // so the (occurred_at, id) tie-break is unambiguous and the test's
      // expectations are deterministic.
      const baseTime = new Date('2026-05-01T00:00:00Z').getTime()
      for (let i = 0; i < 51; i++) {
        await billingHistory.append(
          tx,
          makeRow({
            user_id: user.id,
            kind: 'purchase',
            source_id_stripe: `pi_page_${String(i)}`,
            occurred_at: new Date(baseTime + i * 1000),
            amount_cents: i,
          }),
        )
      }

      const page1 = await billingHistory.listByUser(tx, user.id, { limit: 50 })
      expect(page1.rows).toHaveLength(50)
      expect(page1.nextCursor).not.toBeNull()
      // Sorted DESC by occurred_at: row 50 (latest, amount 50) first, row 1 (amount 1) last in page 1.
      expect(page1.rows[0]?.amount_cents).toBe(50)
      expect(page1.rows[49]?.amount_cents).toBe(1)

      // Page 2: pass the cursor from page 1; should return the remaining 1 row
      // (amount_cents = 0 — the oldest) and nextCursor=null.
      const cursor = page1.nextCursor
      if (cursor === null) {
        throw new Error('expected non-null cursor after page 1')
      }
      // The repo's nextCursor is a JSON string of { t, i } — the route layer
      // (Task 28) base64url-encodes the wire form on top. Tests parse the
      // JSON to get the decoded `{ t, i }` shape that listByUser accepts.
      const parsed: unknown = JSON.parse(cursor)
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { t?: unknown }).t !== 'string' ||
        typeof (parsed as { i?: unknown }).i !== 'string'
      ) {
        throw new Error('cursor JSON did not decode to { t, i }')
      }
      const cursorParsed: { t: string; i: string } = {
        t: (parsed as { t: string }).t,
        i: (parsed as { i: string }).i,
      }
      const page2 = await billingHistory.listByUser(tx, user.id, {
        cursor: cursorParsed,
        limit: 50,
      })
      expect(page2.rows).toHaveLength(1)
      expect(page2.rows[0]?.amount_cents).toBe(0)
      expect(page2.nextCursor).toBeNull()
    })
  })

  it('listByUser cursor tie-break: rows with identical occurred_at sort by id DESC, paginate cleanly', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      // Insert 3 rows with IDENTICAL occurred_at — the lexicographic
      // (occurred_at, id) row-comparison must fall through to id DESC
      // for deterministic pagination. uuidv7() is monotonically time-
      // ordered so later inserts have lexicographically-larger ids.
      const sameTime = new Date('2026-05-01T00:00:00Z')
      const ids: string[] = []
      for (let i = 0; i < 3; i++) {
        const id = uuidv7()
        ids.push(id)
        await billingHistory.append(
          tx,
          makeRow({
            id,
            user_id: user.id,
            kind: 'purchase',
            source_id_stripe: `pi_tie_${String(i)}`,
            occurred_at: sameTime,
            amount_cents: i,
          }),
        )
      }
      const sortedDesc = [...ids].sort().reverse()  // newest id first

      const page1 = await billingHistory.listByUser(tx, user.id, { limit: 2 })
      expect(page1.rows).toHaveLength(2)
      expect(page1.rows[0]?.id).toBe(sortedDesc[0])
      expect(page1.rows[1]?.id).toBe(sortedDesc[1])
      expect(page1.nextCursor).not.toBeNull()

      const cursor = page1.nextCursor
      if (cursor === null) throw new Error('expected non-null cursor')
      const parsed: unknown = JSON.parse(cursor)
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { t?: unknown }).t !== 'string' ||
        typeof (parsed as { i?: unknown }).i !== 'string'
      ) {
        throw new Error('cursor JSON did not decode to { t, i }')
      }
      const cursorParsed: { t: string; i: string } = {
        t: (parsed as { t: string }).t,
        i: (parsed as { i: string }).i,
      }
      const page2 = await billingHistory.listByUser(tx, user.id, {
        cursor: cursorParsed,
        limit: 2,
      })
      expect(page2.rows).toHaveLength(1)
      expect(page2.rows[0]?.id).toBe(sortedDesc[2])
      expect(page2.nextCursor).toBeNull()
    })
  })

  it("prefix-by-kind CHECK: append with kind='purchase' and source_id_stripe='in_xxx' raises 23514", async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      let caught: unknown
      try {
        await billingHistory.append(
          tx,
          makeRow({
            user_id: user.id,
            kind: 'purchase',
            source_id_stripe: 'in_wrong_prefix', // mismatched prefix for kind='purchase'
          }),
        )
      } catch (err) {
        caught = err
      }
      expect(caught).toBeDefined()
      const errCode = (caught as { code?: string }).code
      expect(errCode).toBe('23514')
    })
  })

  it('markRefunded is idempotent: rowcount=1 first call, rowcount=0 second call', async () => {
    await withTx(async (tx) => {
      const user = await createTestUser(tx)
      const inserted = await billingHistory.append(
        tx,
        makeRow({ user_id: user.id, kind: 'purchase', source_id_stripe: 'pi_to_refund' }),
      )
      const first = await billingHistory.markRefunded(tx, inserted.id)
      expect(first.rowsAffected).toBe(1)
      // Second call: the row's status is now 'refunded'; the WHERE status='completed'
      // gate makes the second call a no-op.
      const second = await billingHistory.markRefunded(tx, inserted.id)
      expect(second.rowsAffected).toBe(0)
      // Verify the persisted status didn't flip back.
      const result = await tx.query<{ status: string }>(
        `SELECT status FROM billing_history WHERE id = $1`,
        [inserted.id],
      )
      expect(result.rows[0]?.status).toBe('refunded')
    })
  })
})
