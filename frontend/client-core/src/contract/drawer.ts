import type { BaseProps } from './index.ts'

/**
 * Edge-handle drawer — a full-width sheet that slides in from the RIGHT edge,
 * summoned/dismissed by a handle pinned at the right edge of the viewport (the
 * same spot in both states). The mobile world-reveal uses it to hold the wiki
 * over the fullscreen graph (MYT-89 Phase D).
 *
 * Unlike {@link ModalProps Modal}, the sheet's children stay MOUNTED while
 * closed (the web impl slides the sheet off-screen with a transform and marks
 * it `inert` — it never unmounts). That mount-persistence is load-bearing:
 * consumer state inside the drawer (wiki navigation, per-entry scroll, form
 * input) survives close→open. Under reduced motion the slide collapses to the
 * end states.
 *
 * The handle is part of the component (it IS the trigger): a square paper tab
 * that toggles the drawer and receives focus back when the sheet closes. Its
 * accessible name flips between `openLabel` (closed → summon) and `closeLabel`
 * (open → dismiss). Focus moves into the sheet on open and `Esc` dismisses.
 * While open, Tab is CONTAINED (a wrap-at-the-edges loop) — deliberately
 * weaker than Modal's hard trap. Mount-persistence forces the web impl to be
 * non-modal (a force-mounted modal Radix Dialog would aria-hide + scroll-lock
 * the whole app while the drawer is CLOSED), and non-modal means no
 * document-level recapture: focus that leaves by non-Tab means (a pointer, a
 * script) is not pulled back. Consequences a consumer beyond the fullscreen
 * mobile reveal should know:
 *  - No scroll lock: the page behind an open drawer stays scrollable.
 *  - Focus-in fires on the closed→open TRANSITION only. A drawer mounted
 *    already-open (`defaultOpen`) does not move focus on load — intentional,
 *    the drawer is a summoned-from-closed pattern.
 *  - The closed sheet stays mounted, so its dismiss listeners exist while
 *    closed: when it is the topmost dismissable layer, a stray `Esc` keydown
 *    gets its DOM default prevented (the impl swallows the spurious dismiss;
 *    no `onOpenChange` fires).
 *
 * Controlled when `open` is supplied (pair with `onOpenChange`); uncontrolled
 * with `defaultOpen` otherwise. Open/close is the neutral `onOpenChange(open)`
 * boolean (§9), never a DOM event.
 */
export interface DrawerProps extends BaseProps {
  /**
   * Accessible name for the sheet — an i18n key the consumer resolves.
   * REQUIRED: it wires `aria-labelledby`, so the drawer always has a name.
   * Rendered as the sheet's serif heading.
   */
  title: string
  /**
   * Optional supporting description — an i18n key. Wired to `aria-describedby`
   * and rendered under the title.
   */
  description?: string
  /**
   * Accessible label for the handle while the drawer is CLOSED (the summon
   * affordance) — an i18n key (e.g. `worldreveal.wiki.open`). REQUIRED so the
   * icon-only handle is never nameless.
   */
  openLabel: string
  /**
   * Accessible label for the handle while the drawer is OPEN (the dismiss
   * affordance) — an i18n key (e.g. `worldreveal.wiki.close`). REQUIRED.
   */
  closeLabel: string
  /** Controlled open state. When supplied the Drawer is controlled (pair with `onOpenChange`). */
  open?: boolean
  /** Uncontrolled initial open state. Ignored when `open` is supplied. */
  defaultOpen?: boolean
  /** Neutral open-state callback — receives the next boolean, not a DOM event (§9). */
  onOpenChange?: (open: boolean) => void
}
