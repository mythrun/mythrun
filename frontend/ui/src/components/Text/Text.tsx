import { forwardRef } from 'react'
import type { TextProps } from '@mythrun/client-core/contract'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// Inline/block text primitive. The `role` selects a full static token class
// string from TYPE_ROLE_CLASS; `as` selects the semantic element from a fixed
// {span,p} enum (NOT a DOM passthrough — no className/style prop). Replaces the
// W0 placeholder text.tsx.
export const Text = forwardRef<HTMLElement, TextProps>(function Text(
  { role = 'prose-body', as = 'span', children, ...rest },
  ref,
) {
  const className = TYPE_ROLE_CLASS[role]
  if (as === 'p') {
    return (
      <p ref={ref as React.Ref<HTMLParagraphElement>} className={className} {...rest}>
        {children}
      </p>
    )
  }
  return (
    <span ref={ref} className={className} {...rest}>
      {children}
    </span>
  )
})
