import { forwardRef, useId, useState } from 'react'
import type { InvitePanelProps } from '@mythrun/client-core/contract'
import { Button } from '../Button/Button.tsx'
import { Input } from '../Input/Input.tsx'
import { Banner } from '../Banner/Banner.tsx'
import { Label } from '../Label/Label.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// InvitePanel (MYT-91 invite & party) — the owner's share surface on the campaign
// page: ONE primary invite link and three neutral actions (copy, native-share,
// replace). Deliberately not a dashboard — a single link, terse. Pure and
// presentational: every decided boolean (`loading`/`canShare`/`copied`, the
// `notice` arm) arrives resolved, and the actions are neutral callbacks — the web
// route owns the clipboard / `navigator.share` / network mechanics (R1: this
// layer never touches a web global). The link is null while loading and after a
// revoke with no fresh link (then the panel offers `onCreate`).
//
// BRAND — flat 1-bit / SQUARE / paper register (like PartyRoster): the eyebrow is
// ember mono, the link value is the mono UI face inside a read-only DS Input,
// actions reuse the DS Button variants, and a calm notice rides the shipped
// Banner. NO status dot/chip/badge and NO circles (`rounded-none` everywhere the
// primitives don't already enforce it) — state reads as prose, a field, or the
// Banner, never a decorated pill.
//
// Responsive: a plain flex column; the link field is full-width (`block w-full`)
// and the action row WRAPS (`flex-wrap`), so it reads the same at a desktop
// measure and at ~375px. The consuming screen owns the max-width.
//
// COPY — every user-visible string arrives resolved via `labels` (MYT-100 lifted them
// into the contract, same pattern as PartyRoster; the DS owns no copy). The calm-notice
// Banner severity is the only chrome decision that stays DS-side.

// The calm-notice arm → its Banner severity (the DS keeps the severity mapping; the
// line body arrives via `labels`). `cap-reached` is a soft limit (advisory warning,
// not a failure); `error` is a transient failure (danger). Body text stays --ink
// inside the Banner (§4) — only the glyph takes the severity.
const NOTICE_SEVERITY: Record<'cap-reached' | 'error', 'warning' | 'danger'> = {
  'cap-reached': 'warning',
  error: 'danger',
}

const ROOT_CLASS = 'flex min-w-0 flex-col gap-[var(--space-4)]'
// The panel eyebrow — ember mono, matching PartyRoster's `panelhdr`.
const PANEL_LABEL_CLASS = 'font-ui text-xs font-medium uppercase tracking-wide text-accent-fg'
const HINT_CLASS = 'font-ui text-xs tracking-wide text-ink-tertiary'
const LOADING_CLASS = 'font-ui text-xs uppercase tracking-wide text-ink-tertiary'
const NO_LINK_CLASS = 'font-ui text-xs tracking-wide text-ink-tertiary'
// The link + actions block.
const LINK_BLOCK_CLASS = 'flex min-w-0 flex-col gap-[var(--space-3)]'
// The action row — WRAPS so three actions reflow at ~375px rather than overflow.
const ACTIONS_CLASS = 'flex flex-wrap items-center gap-[var(--space-2)]'
// The replace one-beat confirm — the prompt sits inline before the two controls,
// wrapping at narrow widths. Prose, never a modal (calm paper register).
const CONFIRM_PROMPT_CLASS = 'font-ui text-xs tracking-wide text-ink-secondary'

export const InvitePanel = forwardRef<HTMLDivElement, InvitePanelProps>(function InvitePanel(
  { labels, inviteUrl, loading, canShare, copied, notice, prominence = 'primary', onCopy, onShare, onRevoke, onCreate },
  ref,
) {
  // A unique id per instance ties the read-only link field to its (SR-only) label
  // without colliding when several panels mount (stories, tests) — no static id.
  const linkId = useId()
  // Ephemeral UI micro-state (not business state): the one-beat Replace confirm.
  // Replace strands any already-shared link, so the first press only ARMS the
  // confirm; `onRevoke` fires from the confirm control. Local because no consumer
  // needs to observe the confirm's open/closed — it mirrors a disclosure toggle.
  const [confirmingReplace, setConfirmingReplace] = useState(false)
  // Demoted (`quiet`) invites drop Copy to a bordered secondary so the character
  // reveal / party roster keeps the page's one filled accent; the hub keeps Copy
  // primary.
  const copyVariant = prominence === 'quiet' ? 'secondary' : 'primary'
  const activeNotice =
    notice !== null
      ? { severity: NOTICE_SEVERITY[notice], line: notice === 'cap-reached' ? labels.limit : labels.error }
      : null

  return (
    <div ref={ref} data-testid="invite-panel" className={ROOT_CLASS}>
      <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
        <p className={PANEL_LABEL_CLASS}>{labels.panelHeading}</p>
        <p className={HINT_CLASS}>{labels.hint}</p>
      </div>

      {loading ? (
        <p data-testid="invite-panel-loading" className={LOADING_CLASS}>
          {labels.loading}
        </p>
      ) : inviteUrl === null ? (
        <div className={LINK_BLOCK_CLASS}>
          <p className={NO_LINK_CLASS}>{labels.noLink}</p>
          <div className={ACTIONS_CLASS}>
            <Button variant={copyVariant} onPress={onCreate} data-testid="invite-panel-create">
              {labels.create}
            </Button>
          </div>
        </div>
      ) : (
        <div className={LINK_BLOCK_CLASS}>
          {/* The field carries a real (SR-only) label bound by id — the eyebrow is a
              heading, not a control label, so the read-only input gets its own name. */}
          {/* Not a required field — `requiredLabel` is unused (rendered only when
              `required`), so an empty string satisfies the prop without copy. */}
          <VisuallyHidden>
            <Label htmlFor={linkId} requiredLabel="">
              {labels.linkLabel}
            </Label>
          </VisuallyHidden>
          <Input id={linkId} value={inviteUrl} readOnly data-testid="invite-panel-link" />
          <div className={ACTIONS_CLASS}>
            <Button variant={copyVariant} onPress={onCopy} data-testid="invite-panel-copy">
              {copied ? labels.copied : labels.copy}
            </Button>
            {canShare && (
              <Button variant="secondary" onPress={onShare} data-testid="invite-panel-share">
                {labels.share}
              </Button>
            )}
            {confirmingReplace ? (
              <>
                <span className={CONFIRM_PROMPT_CLASS}>{labels.replacePrompt}</span>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setConfirmingReplace(false)
                    onRevoke()
                  }}
                  data-testid="invite-panel-replace-confirm"
                >
                  {labels.replaceConfirm}
                </Button>
                <Button
                  variant="ghost"
                  onPress={() => {
                    setConfirmingReplace(false)
                  }}
                  data-testid="invite-panel-replace-cancel"
                >
                  {labels.replaceCancel}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                onPress={() => {
                  setConfirmingReplace(true)
                }}
                data-testid="invite-panel-revoke"
              >
                {labels.replace}
              </Button>
            )}
          </div>
        </div>
      )}

      {activeNotice !== null && (
        <Banner severity={activeNotice.severity} data-testid="invite-panel-notice">
          {activeNotice.line}
        </Banner>
      )}
    </div>
  )
})
