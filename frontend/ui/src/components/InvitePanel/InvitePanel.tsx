import { forwardRef, useId } from 'react'
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
// COPY — the display strings the component emits are fixed interim chrome deferred
// to the end-of-milestone copy pass (the `[ph:]` convention, like PartyRoster):
// terse generic words (`Invite`, `Copy link`, `Copied`, `Share`, `Replace link`,
// `Create a link`, the field's `Invite link` a11y label) read as real chrome; the
// evocative hint + notice lines are `[ph:]` placeholders. The contract carries no
// strings.

// Fixed chrome / interim copy.
const PANEL_LABEL = 'Invite'
const PANEL_HINT = '[ph: share this link — friends join your party here]'
const LOADING_LINE = '[ph: preparing your invite link…]'
const NO_LINK_LINE = '[ph: no active link — create one to invite]'
const LINK_LABEL = 'Invite link'
const CREATE_LABEL = 'Create a link'
const COPY_LABEL = 'Copy link'
const COPIED_LABEL = 'Copied'
const SHARE_LABEL = 'Share'
const REVOKE_LABEL = 'Replace link'

// The calm-notice arm → its Banner severity + interim line. `cap-reached` is a soft
// limit (advisory warning, not a failure); `error` is a transient failure (danger).
// Body text stays --ink inside the Banner (§4) — only the glyph takes the severity.
const NOTICE: Record<'cap-reached' | 'error', { severity: 'warning' | 'danger'; line: string }> = {
  'cap-reached': {
    severity: 'warning',
    line: '[ph: you’ve reached the invite limit — replace the existing link instead]',
  },
  error: { severity: 'danger', line: '[ph: something went wrong — try again]' },
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
const ACTIONS_CLASS = 'flex flex-wrap gap-[var(--space-2)]'

export const InvitePanel = forwardRef<HTMLDivElement, InvitePanelProps>(function InvitePanel(
  { inviteUrl, loading, canShare, copied, notice, onCopy, onShare, onRevoke, onCreate },
  ref,
) {
  // A unique id per instance ties the read-only link field to its (SR-only) label
  // without colliding when several panels mount (stories, tests) — no static id.
  const linkId = useId()
  const activeNotice = notice !== null ? NOTICE[notice] : null

  return (
    <div ref={ref} data-testid="invite-panel" className={ROOT_CLASS}>
      <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
        <p className={PANEL_LABEL_CLASS}>{PANEL_LABEL}</p>
        <p className={HINT_CLASS}>{PANEL_HINT}</p>
      </div>

      {loading ? (
        <p data-testid="invite-panel-loading" className={LOADING_CLASS}>
          {LOADING_LINE}
        </p>
      ) : inviteUrl === null ? (
        <div className={LINK_BLOCK_CLASS}>
          <p className={NO_LINK_CLASS}>{NO_LINK_LINE}</p>
          <div className={ACTIONS_CLASS}>
            <Button variant="primary" onPress={onCreate} data-testid="invite-panel-create">
              {CREATE_LABEL}
            </Button>
          </div>
        </div>
      ) : (
        <div className={LINK_BLOCK_CLASS}>
          {/* The field carries a real (SR-only) label bound by id — the eyebrow is a
              heading, not a control label, so the read-only input gets its own name. */}
          <VisuallyHidden>
            <Label htmlFor={linkId}>{LINK_LABEL}</Label>
          </VisuallyHidden>
          <Input id={linkId} value={inviteUrl} readOnly data-testid="invite-panel-link" />
          <div className={ACTIONS_CLASS}>
            <Button variant="primary" onPress={onCopy} data-testid="invite-panel-copy">
              {copied ? COPIED_LABEL : COPY_LABEL}
            </Button>
            {canShare && (
              <Button variant="secondary" onPress={onShare} data-testid="invite-panel-share">
                {SHARE_LABEL}
              </Button>
            )}
            <Button variant="ghost" onPress={onRevoke} data-testid="invite-panel-revoke">
              {REVOKE_LABEL}
            </Button>
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
