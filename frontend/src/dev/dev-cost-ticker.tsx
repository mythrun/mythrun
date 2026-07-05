/* eslint-disable mythrun-ui/no-ad-hoc-ui, mythrun-ui/no-untranslated-jsx-text, i18next/no-literal-string -- DEV/STAGING-ONLY internal tool. The DevCostTicker is a deliberately ad-hoc floating widget that lives OUTSIDE the design system + i18n: it is never shown to real users (it renders only while the dev/staging-gated /api/dev/api-cost endpoint answers, and hides on the 404 it returns in production). Routing a throwaway dev counter through @mythrun/ui + i18n keys would be gold-plating. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getDevApiCost, isHttpError, useApiContext } from '@mythrun/client-core'

// Poll cadence. Quick enough to feel live as spend ticks up, slow enough to be
// negligible load on the dev backend.
const POLL_MS = 2000

// Small-sum precision: 4 decimals reads well for the fractions-of-a-cent to
// low-dollar range a single dev/smoke session accrues.
function formatDelta(usd: number): string {
  return `$${usd.toFixed(4)}`
}

/**
 * A floating, fixed-position running total of Anthropic API spend for the
 * current dev/staging deploy. Captures the first successful reading as a
 * baseline and displays the delta above it; Reset re-captures the baseline
 * (display → $0.0000). Renders `null` when the endpoint 404s (production, or the
 * route otherwise absent), so it can be mounted unconditionally at the app root.
 */
export function DevCostTicker(): React.JSX.Element | null {
  const ctx = useApiContext()
  const [total, setTotal] = useState<number | null>(null)
  const [baseline, setBaseline] = useState<number | null>(null)
  const [hidden, setHidden] = useState(false)
  const [failed, setFailed] = useState(false)
  // A ref mirror of the baseline so the polling closure (which only re-runs on
  // [ctx]) can test "baseline captured yet?" without a stale `baseline` capture.
  // The state copy is what the render reads, so Reset re-renders the delta.
  const baselineRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async (): Promise<void> => {
      try {
        const { totalUsd } = await getDevApiCost(ctx)
        if (cancelled) return
        if (baselineRef.current === null) {
          baselineRef.current = totalUsd
          setBaseline(totalUsd)
        }
        setTotal(totalUsd)
        setFailed(false)
      } catch (err) {
        if (cancelled) return
        // 404 → the endpoint isn't there (production / not registered). Hide for
        // good and stop polling.
        if (isHttpError(err) && err.status === 404) {
          setHidden(true)
          return
        }
        // Any other failure (dev backend down, transient): show muted, keep polling.
        setFailed(true)
      }
      // The guard is load-bearing: without it an in-flight poll would reschedule
      // AFTER the cleanup ran, leaking a timer that polls past unmount. The
      // type-aware linter narrows `cancelled` to always-false here because it
      // can't model the cleanup closure flipping it across the await — hence the
      // scoped disable.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated by the cleanup during the await; the guard prevents a post-unmount reschedule.
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS)
    }

    void poll()
    return () => {
      cancelled = true
      // clearTimeout is a no-op on undefined (poll may not have scheduled yet).
      clearTimeout(timer)
    }
  }, [ctx])

  const onReset = useCallback(() => {
    if (total !== null) {
      baselineRef.current = total
      setBaseline(total)
    }
  }, [total])

  if (hidden) return null

  const delta = total !== null && baseline !== null ? total - baseline : 0
  const display = failed ? '—' : formatDelta(delta)

  return (
    <div
      data-testid="dev-cost-ticker"
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        zIndex: 2147483647,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        borderRadius: 4,
        background: 'rgba(20,20,20,0.85)',
        color: '#e8e8e8',
        font: '12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
        userSelect: 'none',
        pointerEvents: 'auto',
      }}
    >
      <span data-testid="dev-cost-ticker-value">API {display}</span>
      <button
        type="button"
        onClick={onReset}
        data-testid="dev-cost-ticker-reset"
        style={{
          font: 'inherit',
          color: '#e8e8e8',
          background: 'transparent',
          border: '1px solid #666',
          borderRadius: 3,
          padding: '0 6px',
          cursor: 'pointer',
        }}
      >
        Reset
      </button>
    </div>
  )
}
