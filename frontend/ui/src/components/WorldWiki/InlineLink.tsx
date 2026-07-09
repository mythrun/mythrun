import type { ReactNode } from 'react'
import { cn } from '../../lib/cn.ts'

// InlineLink (MYT-89 D4) — the SCAFFOLD for an in-prose entity mention. The
// plan's §8.1 decision: the wiki body does NOT auto-linkify in v1 — no
// name-matching over fact text (a `Bell`/`Bell-Wardens` collision hazard and
// ZFC-tension pattern-matching). The RELATED footer carries cross-navigation;
// this component exists so a future pipeline that MARKS mentions structurally
// (UUID-resolved, like `related`) has a ready render affordance. Until then it
// is catalogued (story) but composed nowhere.
//
// Render: a native inline <button> painted as a prose link — persistent
// underline (a link inside body text can't signal by color alone), accent-fg
// ink, the prose-body register so it sits flush in the serif fact prose it is
// meant to live inside. Wiki navigation is state, not URLs, hence a button.

const LINK_CLASS = cn(
  'inline bg-transparent p-0 text-left align-baseline cursor-pointer rounded-none',
  'font-body text-base font-normal leading-[1.6]',
  'text-accent-fg underline underline-offset-2 hover:text-accent-fg-hover',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

export interface InlineLinkProps {
  /** The mentioned entity — handed to `onNavigate` on activation. */
  entityId: string
  /** Neutral navigation callback — carries the entity id, never a DOM event. */
  onNavigate: (entityId: string) => void
  /** The mention text — DATA from the marked mention, rendered as-is. */
  children?: ReactNode
}

export function InlineLink({ entityId, onNavigate, children }: InlineLinkProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate(entityId)
      }}
      className={LINK_CLASS}
    >
      {children}
    </button>
  )
}
