import { forwardRef } from 'react'
import { Avatar as RadixAvatar } from 'radix-ui'
import type { AvatarProps, AvatarSize } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Avatar — an identity image with a deterministic INITIALS fallback, built on the
// unstyled `radix-ui` Avatar primitive. Radix supplies the headline behavior: it
// renders `Avatar.Image` only once the underlying <img> reports a successful
// `load`, and swaps to `Avatar.Fallback` on a missing/broken src — so the
// fallback path is real load-state, not a guess. The native mirror is the same
// image-with-fallback contract; the DOM-free `AvatarProps` keeps the swap
// mechanical.
//
// Visual exception (§3): avatars are the brand's one sanctioned ROUND shape (like
// the radio dot) — a conventional affordance the flat-1-bit register makes an
// explicit exception for. So `rounded-full` here, sharp corners everywhere else.
//
// The fallback initials sit on the `--surface` tier with `--border-strong` edge +
// `--ink` text (the quiet brand chip), mono `font-ui` (identity initials read as
// data). The fallback delay is conditional: with NO `src` the fallback is the
// RESTING state, so we omit `delayMs` (Radix renders it immediately — passing
// `delayMs={0}` would defer it one timer tick, flashing empty first). With a
// `src` we delay 0ms so the image gets its load tick before the fallback paints,
// avoiding an initials→image flash.
//
// a11y: the Root is `role="img"` + `aria-label={name}`, so the avatar carries
// the identity name in EVERY load state (image, fallback, or mid-load) — one
// stable accessible name. The inner pieces are therefore decorative: the
// `Avatar.Image` is `alt=""` (the Root names it; a named inner img would
// double-announce), and the initials text is `aria-hidden` (so AT doesn't read
// "AL" on top of "Ada Lovelace").

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: 'w-[var(--control-sm)] h-[var(--control-sm)] text-xs',
  md: 'w-[var(--control-md)] h-[var(--control-md)] text-sm',
  lg: 'w-[var(--control-lg)] h-[var(--control-lg)] text-base',
}

/** 1–2 initials from a name: first letter of the first two whitespace-split
 *  words, uppercased. A single-word name yields one initial; an empty/blank name
 *  yields '' (the Root's aria-label still names it). */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  { name, src, size = 'md', 'data-testid': dataTestId },
  ref,
) {
  return (
    <RadixAvatar.Root
      ref={ref}
      role="img"
      aria-label={name}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden',
        'rounded-full align-middle',
        SIZE_CLASS[size],
      )}
    >
      {src !== undefined ? (
        <RadixAvatar.Image src={src} alt="" className="h-full w-full object-cover" />
      ) : null}
      <RadixAvatar.Fallback
        {...(src !== undefined ? { delayMs: 0 } : {})}
        aria-hidden="true"
        className={cn(
          'flex h-full w-full items-center justify-center',
          'bg-surface text-ink border border-border-strong',
          'font-ui font-medium leading-none',
        )}
      >
        {initialsOf(name)}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  )
})
