import { forwardRef } from 'react'
import type { CreditBalanceProps } from '@mythrun/client-core/contract'
import { Stack } from '../Stack/Stack.tsx'
import { Grid } from '../Grid/Grid.tsx'
import { Card, CardBody } from '../Card/Card.tsx'
import { Text } from '../Text/Text.tsx'

// CreditBalance (MYT-95) — the two-bucket credit readout on the Sessions & Billing
// settings surface. It itemises the SESSION and WORLD-GEN buckets as two independent
// labeled mono readouts. The two buckets are NEVER conflated and NO summed total is
// rendered (spec §4) — there is no `total` line, by construction.
//
// Pure/presentational: it reflects the two numbers + their shell-owned i18n'd copy
// exactly as passed (the shell owns the copy and any Intl formatting, like the shipped
// HeaderCredits). Composed only from the DS Stack/Grid/Card/Text primitives — no ad-hoc
// layout or type classes. Register: flat 1-bit paper, machine-mono values
// (`role="data"`), mono field labels (`role="ui-label"`), square by construction (the
// primitives carry no radius), NO chips/dots/badges.
//
// EXPLAINED TILES (myth-9jrh9). Run-1 rendered each bucket as ONE full-width justified
// row, which produced two defects on a 1280px settings column: the label sat ~1200px
// from its own number (nothing binds them — "two unrelated things that happen to share
// a row"), and neither number said what the currency actually WAS. Both are structural,
// so the fix is structural:
//   • Each bucket is a BOUNDED tile (a paper Card in an auto-fill track, ~300px), so
//     label and value are bound by the tile, not by a leader line the register bans.
//     Two tiles sit side by side from ~640px and stack at phone widths.
//   • Each tile carries its own two-line explainer: what one credit buys, and what the
//     zero state costs you. Both lines are ALWAYS visible, not gated on `count === 0` —
//     the point is to teach the currency BEFORE the player hits the wall, and a paid
//     product's two economic units cannot be bare numbers.
// The tiles never reference each other and never sum: an independent-currency invariant
// enforced by the shape of the component, not by a comment.

/** The per-bucket tile: the ledger line (label left, count right) over its two
 *  explainer lines. Bounded, so label and value read as one unit. */
function CreditTile({
  label,
  value,
  help,
  zeroHelp,
  testId,
}: {
  readonly label: string
  readonly value: number
  readonly help: string
  readonly zeroHelp: string
  readonly testId: string
}): React.JSX.Element {
  return (
    <Card data-testid={testId}>
      <CardBody>
        <Stack gap={2}>
          <Stack direction="row" justify="between" align="center" gap={4}>
            <Text role="ui-label" truncate>
              {label}
            </Text>
            <Text role="data" noShrink data-testid={`${testId}-value`}>
              {value}
            </Text>
          </Stack>
          {/* The explainers stay in the full-ink `ui-caption` register (not the muted
              `meta`): this is the copy that makes the number mean something, so it
              holds contrast rather than reading as a footnote. */}
          <Stack gap={1}>
            <Text role="ui-caption" as="p" data-testid={`${testId}-help`}>
              {help}
            </Text>
            <Text role="ui-caption" as="p" data-testid={`${testId}-zero-help`}>
              {zeroHelp}
            </Text>
          </Stack>
        </Stack>
      </CardBody>
    </Card>
  )
}

export const CreditBalance = forwardRef<HTMLDivElement, CreditBalanceProps>(function CreditBalance(
  {
    session,
    sessionLabel,
    sessionHelp,
    sessionZeroHelp,
    worldGen,
    worldGenLabel,
    worldGenHelp,
    worldGenZeroHelp,
    'data-testid': testId = 'credit-balance',
  },
  ref,
) {
  return (
    // auto-FILL (not auto-fit): the tiles HOLD ~300px rather than stretching to half a
    // 1200px column each, which would re-open the very label→value reading gap the
    // tiles exist to close. Extra room becomes empty track; at phone widths the pair
    // wraps to one column.
    <Grid ref={ref} columns="auto-fill" minColumnPx={300} gap={4} data-testid={testId}>
      <CreditTile
        label={sessionLabel}
        value={session}
        help={sessionHelp}
        zeroHelp={sessionZeroHelp}
        testId="credit-balance-session"
      />
      <CreditTile
        label={worldGenLabel}
        value={worldGen}
        help={worldGenHelp}
        zeroHelp={worldGenZeroHelp}
        testId="credit-balance-world-gen"
      />
    </Grid>
  )
})
