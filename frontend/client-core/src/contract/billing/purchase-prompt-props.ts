// PurchasePrompt (MYT-95) — the DOM-free prop vocabulary for the out-of-session-
// credits prompt MYT-92 renders on a session-start 402. The `variant` is decided by
// the shell from campaign ownership (client-core `purchasePromptModel`): the campaign
// OWNER carries the buy path; a NON-owner gets a calm notice with NO buy CTA —
// buying would credit the non-owner's ledger and never unblock the OWNER's session.
// Platform-neutral (§9): pure data + shell-owned i18n'd copy + neutral handlers, no
// DOM types, no className.
//
// LEDGER GUARD (load-bearing): `variant` — NOT prop presence — is the sole gate on the
// buy path. Even when buyLabel/quantityPresets/onBuy are supplied, a `nonOwner` NEVER
// renders them.

/** Props for the out-of-session-credits purchase prompt (owner buy path / nonOwner notice). */
export interface PurchasePromptProps {
  /** Owner ⇒ the buy path; nonOwner ⇒ a calm notice, NO buy CTA (the ledger guard). */
  readonly variant: 'owner' | 'nonOwner'
  /** The i18n'd prompt heading (copy stays in the shell, not the DS). */
  readonly heading: string
  /** The i18n'd prompt body prose. */
  readonly body: string
  /** OWNER only: the i18n'd buy verb — the accessible name of the preset group.
   *  Ignored (never rendered) for nonOwner. */
  readonly buyLabel?: string
  /** OWNER only: terse quantity presets (e.g. [1, 4, 8]); each is clamped to [1, 100]. */
  readonly quantityPresets?: readonly number[]
  /** OWNER only: fired with the chosen (clamped) quantity when a preset is pressed. */
  readonly onBuy?: (quantity: number) => void
  /** Optional dismiss. The control renders only when BOTH `onDismiss` and
   *  `dismissLabel` are supplied — an icon-only control needs an accessible name,
   *  so it is never rendered nameless (mirrors Banner's dismiss contract). */
  readonly onDismiss?: () => void
  /** The i18n'd accessible name for the dismiss control (required to render it). */
  readonly dismissLabel?: string
  /** Test hook on the root element. */
  readonly 'data-testid'?: string
}
