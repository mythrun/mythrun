import { forwardRef } from 'react'
import type { PurchasePromptProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Stack } from '../Stack/Stack.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Button } from '../Button/Button.tsx'
import { IconButton } from '../IconButton/IconButton.tsx'

// PurchasePrompt (MYT-95) — the out-of-session-credits prompt MYT-92 renders on a
// session-start 402. Two variants, decided by the shell from campaign ownership
// (client-core `purchasePromptModel`): the campaign OWNER gets the buy path; a
// NON-owner gets a calm notice with NO buy CTA.
//
// Register: a quiet flat paper panel (§3 — `rounded-none`, a 1px `--border-strong`
// edge over the paper surface, NO shadow), prose-first (serif Heading + body Text),
// NO chips/dots/badges. The preset quantities are plain secondary Buttons in a
// labelled group, never chips.
//
// LEDGER GUARD (load-bearing): the buy path is gated on `variant === 'owner'`, NOT on
// prop presence — a nonOwner NEVER renders a buy CTA even when buyLabel/
// quantityPresets/onBuy are passed, because buying would credit the non-owner's
// ledger and never unblock the OWNER's session. The nonOwner branch reads none of
// those props.

// Clamp a preset quantity to the purchasable range [1, 100]. Mechanical bound
// (ZFC-exempt): the label AND the callback both use the clamped value, so a button
// never advertises a quantity it would not buy.
function clampQuantity(n: number): number {
  return Math.max(1, Math.min(100, Math.trunc(n)))
}

export const PurchasePrompt = forwardRef<HTMLDivElement, PurchasePromptProps>(function PurchasePrompt(
  {
    variant,
    heading,
    body,
    buyLabel,
    quantityPresets,
    onBuy,
    onDismiss,
    dismissLabel,
    'data-testid': testId = 'purchase-prompt',
  },
  ref,
) {
  // The buy path renders ONLY for the owner AND only once the shell has supplied the
  // full buy vocabulary. The `variant === 'owner'` clause is the ledger guard above;
  // the rest is defensive completeness (never a half-rendered buy row).
  const showBuy =
    variant === 'owner' &&
    buyLabel !== undefined &&
    onBuy !== undefined &&
    quantityPresets !== undefined &&
    quantityPresets.length > 0
  // An icon-only dismiss needs an accessible name — render it only when the shell
  // supplies both the handler and its label (never a nameless control).
  const showDismiss = onDismiss !== undefined && dismissLabel !== undefined

  return (
    <div
      ref={ref}
      data-testid={testId}
      className={cn(
        'flex flex-col gap-[var(--space-3)]',
        'rounded-none border border-border-strong bg-surface p-[var(--space-5)]',
      )}
    >
      {/* Title row — the prompt heading, with the optional dismiss trailing it. */}
      <Stack direction="row" justify="between" align="start" gap={3}>
        <Heading level={2} role="title">
          {heading}
        </Heading>
        {showDismiss ? (
          <IconButton
            icon="close"
            label={dismissLabel}
            variant="ghost"
            size="sm"
            onPress={onDismiss}
          />
        ) : null}
      </Stack>

      {/* Body prose — the brand's serif prose face (prose-first register). */}
      <Text as="p" role="prose-body">
        {body}
      </Text>

      {/* Owner buy path: one plain secondary Button per clamped preset, in a group
          named by the buy verb (so the copy stays a single shell-owned string — no
          interpolated "buy N" per button). */}
      {showBuy ? (
        <div
          role="group"
          aria-label={buyLabel}
          data-testid={`${testId}-buy`}
          className="flex flex-wrap gap-[var(--space-2)]"
        >
          {quantityPresets.map((preset, index) => {
            const quantity = clampQuantity(preset)
            return (
              <Button
                key={index}
                variant="secondary"
                size="sm"
                onPress={() => {
                  onBuy(quantity)
                }}
                data-testid={`${testId}-buy-${String(quantity)}`}
              >
                {quantity}
              </Button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
})
