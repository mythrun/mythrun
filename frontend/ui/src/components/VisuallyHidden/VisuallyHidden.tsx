import { forwardRef } from 'react'
import { VisuallyHidden as RadixVisuallyHidden } from 'radix-ui'
import type { VisuallyHiddenProps } from '@mythrun/client-core/contract'

// Screen-reader-only wrapper. Removes its children from the visual layout while
// keeping them in the accessibility tree (SR-only labels, orienting headings).
// Wraps radix-ui's VisuallyHidden.Root, which applies the canonical clip/inset
// SR-only style; we expose only `children` (no visual props) per the contract.
export const VisuallyHidden = forwardRef<HTMLSpanElement, VisuallyHiddenProps>(
  function VisuallyHidden({ children, ...rest }, ref) {
    return (
      <RadixVisuallyHidden.Root ref={ref} {...rest}>
        {children}
      </RadixVisuallyHidden.Root>
    )
  },
)
