import type { BaseProps } from './index.ts'

/**
 * The flow ESCAPE-HATCH line (ux-run2 myth-vjl7d) — a quiet one-line offer to
 * leave the current guided path ("Feeling constrained? Describe your world
 * yourself."). The framing `prompt` reads as ambient chrome; the `action`
 * phrase is the pressable part and carries a REAL link affordance (underline +
 * accent), so the hatch reads as actionable instead of a stray caption — the
 * run-2 player never recognised the bare-text hatch as pressable.
 *
 * An in-flow mode switch, not navigation: the action is a `<button>` firing
 * the neutral `onPress` intent. Both strings arrive resolved (i18n lives with
 * the consumer). If a flow offers the hatch at all, offer it on EVERY step —
 * presence consistency is the consumer's contract.
 */
export interface HatchLineProps extends BaseProps {
  /** The quiet framing phrase before the action (resolved string). Optional —
   *  some hatches are all action. */
  prompt?: string
  /** The actionable phrase — underlined, accent, pressable (resolved string). */
  action: string
  /** Activation intent (neutral — the consumer owns what "leaving" means). */
  onPress: () => void
}
