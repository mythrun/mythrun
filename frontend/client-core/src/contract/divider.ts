import type { BaseProps } from './index.ts'

/**
 * A 1px decorative rule that separates content. Uses the decorative `--border`
 * token (a quiet sub-3:1 line — it is non-interactive chrome, not a control
 * boundary). Carries a `separator` role with the matching `aria-orientation`.
 */
export interface DividerProps extends BaseProps {
  /** Rule axis. Default `horizontal`. */
  orientation?: 'horizontal' | 'vertical'
}
