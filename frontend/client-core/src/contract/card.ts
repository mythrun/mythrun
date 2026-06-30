import type { BaseProps } from './index.ts'

/**
 * Flat container with optional header / body / footer slots. Depth rides on the
 * brand's flat 1-bit register (§3): a 1px `--border-strong` edge over a paper
 * surface tier, 0px radius, NO shadow. Use it to group related content into a
 * bounded panel — a titled card, a list item, a form section.
 *
 * Compound-component / slot pattern (§9): compose `Card` with `CardHeader`,
 * `CardBody`, and `CardFooter`. `Card` is a neutral generic container — it
 * imposes no role and no implicit heading; if a `CardHeader` carries a heading,
 * that is the consumer's call (render a {@link HeadingProps Heading} inside it).
 */
export interface CardProps extends BaseProps {
  /**
   * Elevation surface: `base` (`--surface`) or `raised` (`--surface-raised`,
   * popover tier). Default `base`. Depth is the surface tier + the
   * `--border-strong` edge, never a shadow.
   */
  surface?: 'base' | 'raised'
  /**
   * Responsive "collapse to native on mweb" mode. Default `false` (a bordered card
   * at every width). When `true`, the card adapts to the viewport — the general
   * pattern for a panel that should feel like a CARD on desktop but NATIVE/inline
   * on a phone:
   *  - BELOW the `sm` breakpoint (<640px): drops its border, surface, AND padding
   *    entirely — the content sits inline, full-width, on the bare page (no surface
   *    change — the native-mweb feel).
   *  - AT `sm` and up (≥640px): the normal bordered card — surface + `--border-strong`
   *    edge + padding — with a centered ~420px max-width.
   * In collapse mode the Card carries its OWN padding (at sm+); the header/body/footer
   * slot pattern is not used with it.
   */
  collapse?: boolean
  /**
   * Edge treatment for the `--border-strong` Card border. Default `solid` (the
   * standard 1px interactive-grade edge). `dashed` swaps the border STYLE to
   * dashed while keeping the same strong edge color — the empty-state / "not yet
   * written" cover (e.g. the campaign hub's "Unwritten" tile), reading as an
   * outline-to-be-filled rather than a committed surface. Composes with
   * `surface` and `collapse` (in collapse mode the dashed edge appears at `sm`+,
   * where the border itself returns).
   */
  frame?: 'solid' | 'dashed'
}

/**
 * Top region of a {@link CardProps Card}. Token-padded, with a 1px decorative
 * `--border` divider along its bottom edge separating it from the body. A
 * generic container — supply your own {@link HeadingProps Heading} as a child
 * if the card is titled.
 */
export type CardHeaderProps = BaseProps

/** Main content region of a {@link CardProps Card}. Token-padded, no divider. */
export type CardBodyProps = BaseProps

/**
 * Bottom region of a {@link CardProps Card}. Token-padded, with a 1px decorative
 * `--border` divider along its top edge separating it from the body — the home
 * for card actions (a footer {@link ButtonProps Button}).
 */
export type CardFooterProps = BaseProps
