import { forwardRef } from 'react'
import type { TextProps } from '@mythrun/client-core/contract'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { cn } from '../../lib/cn.ts'

// Inline/block text primitive. The `role` selects a full static token class
// string from TYPE_ROLE_CLASS; `as` selects the semantic element from a fixed
// {span,p} enum (NOT a DOM passthrough — no className/style prop). `truncate`
// is the opt-in single-line ellipsis (overflow-hidden + text-ellipsis +
// whitespace-nowrap); in a flex context it relies on the parent Stack's
// [&>*]:min-w-0 so the item can shrink below its content. `noShrink` is the
// opposite opt-in (flex-shrink:0): a short fixed label/value holds its width and
// never spills, so the truncating sibling absorbs the row's shrink. NOTE
// (R2/native): the native Text maps `truncate`→numberOfLines={1} and
// `noShrink`→flexShrink:0, same contract.
export const Text = forwardRef<HTMLElement, TextProps>(function Text(
  { role = 'prose-body', as = 'span', truncate = false, noShrink = false, children, ...rest },
  ref,
) {
  const className = cn(
    TYPE_ROLE_CLASS[role],
    truncate && 'overflow-hidden text-ellipsis whitespace-nowrap',
    noShrink && 'shrink-0',
  )
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
