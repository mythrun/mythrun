import { forwardRef } from 'react'
import { Avatar as RadixAvatar } from 'radix-ui'
import type { AvatarProps, AvatarSize, AvatarColor } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { avatarColorFor } from './avatar-color.ts'

// Avatar — an identity image with a deterministic INITIALS fallback, built on the
// unstyled `radix-ui` Avatar primitive. Radix supplies the headline behavior: it
// renders `Avatar.Image` only once the underlying <img> reports a successful
// `load`, and swaps to `Avatar.Fallback` on a missing/broken src — so the
// fallback path is real load-state, not a guess. The native mirror is the same
// image-with-fallback contract; the DOM-free `AvatarProps` keeps the swap
// mechanical.
//
// Flat 1-bit (§3): 0px radius EVERYWHERE — avatars are SQUARE (`rounded-none`), no
// rounded exception. The square frame matches the pixel-art register; the image is
// `object-cover` so it fills the square without distortion. The 1px
// `--border-strong` edge lives on the ROOT, so BOTH the image variant AND the
// initials chip are a bordered square (an image avatar is framed, not borderless);
// the image is clipped inside the bordered frame by the root's `overflow-hidden`.
//
// The fallback initials sit on an AVATAR PIGMENT (a `bg-avatar-<color>` token, one
// of the 12 curated "scribe's pigments") with paper-50 initials (≥4.5:1, AA) in
// mono `font-ui` (identity initials read as data). The pigment is either the
// explicit `color` prop or, when omitted, a STABLE name-derived auto-assignment
// (`avatarColorFor` — the same name always yields the same pigment). The
// `--border-strong` edge comes from the root. The fallback delay is conditional:
// with NO `src` the fallback is the RESTING state, so we omit `delayMs` (Radix
// renders it immediately — passing `delayMs={0}` would defer it one timer tick,
// flashing empty first). With a `src` we delay 0ms so the image gets its load tick
// before the fallback paints, avoiding an initials→image flash.
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

// A STATIC name → `bg-avatar-<name>` map. The literal class strings must appear
// verbatim in source so Tailwind's JIT scanner generates each utility (a computed
// `bg-avatar-${color}` template would not be seen by the scanner and the class
// would never be emitted). The `--color-avatar-*` tokens these resolve are in
// theme.css's @theme; the no-ad-hoc-color lint is satisfied because these are
// TOKEN utilities, not raw hex.
const BG_AVATAR_CLASS: Record<AvatarColor, string> = {
  ember: 'bg-avatar-ember',
  sienna: 'bg-avatar-sienna',
  ochre: 'bg-avatar-ochre',
  moss: 'bg-avatar-moss',
  pine: 'bg-avatar-pine',
  verdigris: 'bg-avatar-verdigris',
  lapis: 'bg-avatar-lapis',
  iris: 'bg-avatar-iris',
  heather: 'bg-avatar-heather',
  rose: 'bg-avatar-rose',
  umber: 'bg-avatar-umber',
  slate: 'bg-avatar-slate',
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
  { name, src, size = 'md', color, 'data-testid': dataTestId },
  ref,
) {
  // Explicit `color` wins; otherwise a STABLE name-derived pigment (same name →
  // same color forever). The chip background is a token `bg-avatar-*` utility.
  const pigment = color ?? avatarColorFor(name)
  return (
    <RadixAvatar.Root
      ref={ref}
      role="img"
      aria-label={name}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden',
        // The 1px square frame on the ROOT so the image variant is bordered too.
        'rounded-none align-middle border border-border-strong',
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
          // Pigment chip: a curated avatar token bg + paper-50 initials (≥4.5:1).
          BG_AVATAR_CLASS[pigment],
          'text-paper-50 font-ui font-medium leading-none',
        )}
      >
        {initialsOf(name)}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  )
})
