import { forwardRef } from 'react'
import type { CreditBalanceProps } from '@mythrun/client-core/contract'
import { Stack } from '../Stack/Stack.tsx'
import { Text } from '../Text/Text.tsx'

// CreditBalance (MYT-95) — the two-bucket credit readout on the Sessions & Billing
// settings surface. It itemises the SESSION and WORLD-GEN buckets as two independent
// labeled mono readouts. The two buckets are NEVER conflated and NO summed total is
// rendered (spec §4) — there is no `total` line, by construction.
//
// Pure/presentational: it reflects the two numbers + their shell-owned i18n'd labels
// exactly as passed (the shell owns the copy and any Intl formatting, like the shipped
// HeaderCredits). Composed only from the DS Stack/Text primitives — no ad-hoc layout
// or type classes. Register: flat 1-bit paper, machine-mono values (`role="data"`),
// mono field labels (`role="ui-label"`), square by construction (the primitives carry
// no radius), NO chips/dots/badges. Each bucket is one justified ledger line — label
// left, value right; the value holds its width so a long label truncates rather than
// squeezing the number.
//
// CONTROLLER DECISION (plan Task 12): the header session-credit display already ships
// via MYT-87's HeaderCredits, so the compact `inline` header variant the plan first
// spec'd is descoped — this component serves the settings surface only, where both
// buckets are always present (hence both counts are required, no `variant`).

function CreditReadout({
  label,
  value,
  testId,
}: {
  readonly label: string
  readonly value: number
  readonly testId: string
}): React.JSX.Element {
  return (
    <Stack direction="row" justify="between" align="center" gap={4} data-testid={testId}>
      <Text role="ui-label" truncate>
        {label}
      </Text>
      <Text role="data" noShrink data-testid={`${testId}-value`}>
        {value}
      </Text>
    </Stack>
  )
}

export const CreditBalance = forwardRef<HTMLDivElement, CreditBalanceProps>(function CreditBalance(
  { session, sessionLabel, worldGen, worldGenLabel, 'data-testid': testId = 'credit-balance' },
  ref,
) {
  return (
    <Stack ref={ref} gap={3} data-testid={testId}>
      <CreditReadout label={sessionLabel} value={session} testId="credit-balance-session" />
      <CreditReadout label={worldGenLabel} value={worldGen} testId="credit-balance-world-gen" />
    </Stack>
  )
})
