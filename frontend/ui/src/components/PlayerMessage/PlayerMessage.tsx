import { forwardRef } from 'react'
import type { PlayerMessageProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// PlayerMessage (MYT-92) — one human-at-the-table utterance in the live
// transcript. The register split IS the DM/player distinction (spec §2): the DM
// narrates in the serif body face; the humans speak in the mono `--font-ui` (IBM
// Plex Mono) — the mechanical counterpart. So the whole row sets `font-ui` and
// leans on the token roles (`ui-caption` / `meta` / `data`), NOT a bubble.
//
// Register pins (brand square-1-bit): UX §2 wants a DUAL distinction — face AND
// tint. DmMessage (T10) claimed the raised `bg-surface` paper band, so the player
// row takes the QUIET SIBLING tint `bg-surface-hover` (paper-200 light / paper-700
// dark): a visibly distinct band in BOTH themes (more perceptible off the page than
// surface, 1.16/1.41 vs 1.10/1.12) that stays contrast-safe — every text role
// clears AA on it with headroom (ink 12.08/9.99, muted `meta` 8.60/6.62, ≥4.5). It
// is nominally the hover-surface token, but the row is non-interactive so there is
// no state collision; a dedicated `--surface-sunken` token would be the cleaner DS
// home (flagged for the visual audit). NOT a chat bubble; NO avatar, NO circle, NO
// status dot. The identity line leads with the character name (the persona in the
// fiction — the name the table reads when this player acts) with the display name
// as a muted human handle; the character name is guarded so an unfinalized player
// (Task 16 passes `characterName=''`) shows just the human, never an empty label.
//
// `pending` is the optimistic in-flight own-echo: a quiet dimmed treatment via a
// SOLID quieter ink token — NEVER opacity, and never a spinner — plus `aria-busy`
// so AT knows the line is awaiting the server echo. Opacity is the memorialized
// CharacterLoadingBeat sweep failure: it composites text toward the band and drops
// the muted line under AA (here `meta` @0.6 ≈ 3.15:1). The quiet token is
// `text-ink-secondary`, which IS AA on this darker band in both themes (8.60 /
// 6.62); `text-ink-tertiary` is NOT (4.46 on paper-200, sub-4.5), so secondary —
// not tertiary — is the floor here. It is a STATIC treatment (no motion), so
// reduced-motion needs no special-case, and the player's own text stays fully
// legible (secondary is well above AA).
//
// `text` is DATA (player input), rendered verbatim (enforced-ignorance / ZFC — no
// parsing of message content); `break-words` keeps a long unbroken token from
// forcing horizontal scroll at ~375px.
export const PlayerMessage = forwardRef<HTMLDivElement, PlayerMessageProps>(
  function PlayerMessage({ displayName, characterName, text, pending }, ref) {
    // The quiet in-flight tone: a solid AA-safe token, applied per text element so
    // twMerge overrides `meta`'s own `text-ink-secondary` cleanly (a no-op there).
    const quiet = pending ? 'text-ink-secondary' : undefined
    return (
      <div
        ref={ref}
        {...(pending ? { 'aria-busy': true } : {})}
        className="flex flex-col gap-[var(--space-1)] bg-surface-hover px-[var(--space-3)] py-[var(--space-2)] font-ui"
      >
        {/* myth-ydu35: attribution as the product's label·value convention —
            "Kessa Vurm · Miklos", character primary (the persona the table reads),
            account muted. The interpunct is aria-hidden typographic notation, so
            "Sable Marcus" can never read as one apparent full name. */}
        <div className="flex flex-wrap items-baseline gap-x-[var(--space-2)]">
          {characterName !== '' ? (
            <>
              <span className={cn(TYPE_ROLE_CLASS['ui-caption'], quiet)}>{characterName}</span>
              {/* The interpunct is label·value separator notation, not translatable copy. */}
              <span aria-hidden="true" data-testid="player-attribution-sep" className={cn(TYPE_ROLE_CLASS.meta, quiet)}>
                ·
              </span>
            </>
          ) : null}
          <span className={cn(TYPE_ROLE_CLASS.meta, quiet)}>{displayName}</span>
        </div>
        {/* myth-ydu35: the mono measure caps at ~75ch with opened leading — the
            typewriter voice stays readable typewriting instead of running ~95
            characters at tight leading across the full band. */}
        <p className={cn(TYPE_ROLE_CLASS.data, 'max-w-[75ch] leading-[1.7] break-words', quiet)}>{text}</p>
      </div>
    )
  },
)
