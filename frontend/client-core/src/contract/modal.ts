import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/**
 * Modal dialog. The web impl wraps the unstyled Radix `Dialog` primitive (focus
 * TRAP, focus-RETURN to the trigger on close, `Esc`-to-close, scroll lock, a
 * portalled overlay + panel, ARIA `dialog` wiring), styled 100% with our tokens;
 * the native impl swaps the platform modal behind the same contract.
 *
 * Platform-neutral (§9): open/close is the neutral `onOpenChange(open)` boolean
 * callback, never a DOM event. The surface carries no `className`/`style`/raw DOM
 * events. The `title` is REQUIRED — it becomes the dialog's accessible name
 * (Radix `Dialog.Title` → `aria-labelledby`), so a nameless modal is structurally
 * impossible.
 *
 * Controlled when `open` is supplied (pair with `onOpenChange`); uncontrolled
 * with `defaultOpen` otherwise. Supply a {@link ModalProps.trigger trigger} so the
 * focus-return target is part of the component (the dialog returns focus to it on
 * close); a consumer may instead drive `open` imperatively and omit the trigger.
 */
export interface ModalProps extends BaseProps {
  /**
   * Accessible name for the dialog — an i18n key the consumer resolves. REQUIRED:
   * Radix maps it to `Dialog.Title` and wires `aria-labelledby`, so the dialog
   * always has a name. Rendered as the panel's heading.
   */
  title: string
  /**
   * Optional supporting description — an i18n key. Wired to `aria-describedby` via
   * Radix `Dialog.Description` and rendered under the title.
   */
  description?: string
  /**
   * Accessible label for the close button — an i18n key (e.g. `action.close`).
   * REQUIRED so the icon-only close control is never nameless (mirrors IconButton).
   */
  closeLabel: string
  /**
   * The trigger element (e.g. a {@link ButtonProps Button}). Rendered through
   * Radix `Dialog.Trigger` so opening + focus-RETURN-on-close target it. Omit only
   * when driving `open` imperatively from elsewhere.
   */
  trigger?: ReactNode
  /** Controlled open state. When supplied the Modal is controlled (pair with `onOpenChange`). */
  open?: boolean
  /** Uncontrolled initial open state. Ignored when `open` is supplied. */
  defaultOpen?: boolean
  /** Neutral open-state callback — receives the next boolean, not a DOM event (§9). */
  onOpenChange?: (open: boolean) => void
  /**
   * Whether clicking the scrim (the dimmed area outside the panel) closes the
   * modal. Default `true`. Set `false` for a flow the user must explicitly
   * complete or cancel via a control inside the panel.
   */
  closeOnScrimClick?: boolean
}
