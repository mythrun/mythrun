import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { BalanceResponse } from '@mythrun/contract/rest'
import { getBalance } from '../api/billing.ts'
import { useApiContext } from '../api/client-context.tsx'

export type CheckoutReturnStatus = 'polling' | 'settled' | 'processing'

interface PollConfig {
  readonly intervalMs?: number
  readonly budgetMs?: number
}

/** Polls the balance after a Stripe checkout redirect. The webhook is the source
 *  of truth for the credit grant, so we cannot confirm synchronously: snapshot the
 *  balance at the FIRST poll and poll until it CHANGES (→ settled) or the budget
 *  expires (→ processing — a calm NON-error state, never a failure claim for a
 *  completed payment). A webhook that landed before the first poll yields the
 *  already-updated balance as the baseline, so it never appears to change and the
 *  hook lands on `processing` — the accepted fallback. */
export function useCheckoutReturn(config?: PollConfig): { status: CheckoutReturnStatus } {
  const intervalMs = config?.intervalMs ?? 1500
  const budgetMs = config?.budgetMs ?? 12000
  const ctx = useApiContext()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<CheckoutReturnStatus>('polling')

  useEffect(() => {
    let cancelled = false
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout>
    // Per poll session (effect run): the baseline captured on the first poll.
    let baseline: BalanceResponse | null = null

    const changed = (b: BalanceResponse, base: BalanceResponse): boolean =>
      b.session !== base.session ||
      b.world_gen !== base.world_gen ||
      JSON.stringify(b.active_subscription) !== JSON.stringify(base.active_subscription)

    // Schedule the next poll, or land on `processing` once the budget is spent.
    const scheduleOrExpire = (): void => {
      if (Date.now() - startedAt >= budgetMs) setStatus('processing')
      else timer = setTimeout(() => void tick(), intervalMs)
    }

    const tick = async (): Promise<void> => {
      let b: BalanceResponse
      try {
        b = await getBalance(undefined, ctx)
      } catch {
        // Transient balance-fetch failure — keep polling until the budget expires,
        // then treat it as `processing` (a completed payment is never a failure).
        if (!cancelled) scheduleOrExpire()
        return
      }
      if (cancelled) return
      if (baseline === null) {
        baseline = b
      } else if (changed(b, baseline)) {
        // `cancelled` is provably false here (guarded above, no await since), so the
        // settle is set synchronously before the invalidation is awaited.
        setStatus('settled')
        await queryClient.invalidateQueries({ queryKey: ['billing', 'balance'] })
        return
      }
      scheduleOrExpire()
    }

    timer = setTimeout(() => void tick(), 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [ctx, queryClient, intervalMs, budgetMs])

  return { status }
}
