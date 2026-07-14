import { forwardRef } from 'react'
import type { JoinPreviewProps, AcceptArmKind, Severity } from '@mythrun/client-core/contract'
import { Card } from '../Card/Card.tsx'
import { Stack } from '../Stack/Stack.tsx'
import { Heading } from '../Heading/Heading.tsx'
import { Text } from '../Text/Text.tsx'
import { Button } from '../Button/Button.tsx'
import { Banner } from '../Banner/Banner.tsx'

// JoinPreview (MYT-91) — the public invite landing card on `/join/:code`: the
// campaign a visitor was invited to, who invited them, and the single CTA that
// branches on whether they are signed in (accept inline vs sign in to join). It is
// the world-introduction RECEIVE-SCREEN register — the same paper/serif introduction
// surface as the member-join world-intro summary (a caption eyebrow, a serif
// campaign name, a quiet mono "invited by" line), framed as its OWN card because it
// stands alone on a public page rather than inside the app shell. `collapse` makes
// it a bordered ~420px card on desktop and a flush full-width panel at phone widths.
//
// Pure/presentational — it renders from already-decided props and fires the neutral
// `onAccept`/`onSignIn` callbacks; the route owns the preview fetch, the accept
// request, navigation, and retry. Two failure surfaces, both calm (never an alarm):
//   • `valid === false` — the invite previewed but is revoked/expired (a 200, so the
//     real campaign/owner still show); render the calm invalid notice and NO CTA
//     (there is nothing to accept). The thrown-404 "invite never existed" arm is a
//     terminal notice the ROUTE renders standalone — this component never sees it.
//   • `arm !== null` — a post-accept failure resolved to one of the AcceptArmKind
//     calm-notice arms; render its Banner. The CTA stays (the route decides whether
//     to navigate away or let a transient arm retry — the component stays neutral).
//
// BRAND — status is a calm inline Banner, never a dot/chip/badge; the register avoids
// `danger` (red alarm): the terminal soft-blocks (full/revoked/gone/not-found) read
// as advisory `info`, the transient failures (timeout/error) as `warning`. Flat
// 1-bit, square (Card is `rounded-none`), responsive by construction.
//
// COPY — the display strings the component itself emits are fixed interim chrome
// deferred to the end-of-milestone copy pass (the `[ph:]` convention, like
// PartyRoster / CharacterLoadingBeat); the committed contract carries none of them.
// Only the campaign name + owner (real data) arrive as props.

// Fixed chrome / interim copy.
const EYEBROW = '[ph: you have been invited]'
// The owner's display name is interpolated after this quiet prefix.
const INVITED_BY = '[ph: invited by]'
const ACCEPT_CTA = '[ph: accept the invitation →]'
const SIGNIN_CTA = '[ph: sign in to join →]'
const INVALID_LINE = '[ph: this invite is no longer valid]'

// One calm notice per post-accept arm. Severity keeps the register calm: the
// terminal soft-blocks are advisory `info`; the transient failures worth a retry are
// `warning`. No arm is `danger` — a failed join is never a red alarm.
interface ArmNotice {
  readonly severity: Severity
  readonly line: string
}
const ARM_NOTICE: Record<AcceptArmKind, ArmNotice> = {
  full: { severity: 'info', line: '[ph: this campaign is already full]' },
  revoked: { severity: 'info', line: '[ph: this invite link was turned off]' },
  gone: { severity: 'info', line: '[ph: this campaign is no longer available]' },
  'not-found': { severity: 'info', line: "[ph: we couldn't find that invite]" },
  timeout: { severity: 'warning', line: '[ph: that took too long — try again]' },
  error: { severity: 'warning', line: '[ph: something went wrong — try again]' },
}

// The calm notice to surface, if any: the invalid-preview state takes precedence
// over a post-accept arm (an invalid invite can't have been accepted).
function resolveNotice(valid: boolean, arm: AcceptArmKind | null): ArmNotice | null {
  if (!valid) return { severity: 'info', line: INVALID_LINE }
  if (arm !== null) return ARM_NOTICE[arm]
  return null
}

export const JoinPreview = forwardRef<HTMLDivElement, JoinPreviewProps>(function JoinPreview(
  { campaignName, ownerName, valid, signedIn, accepting, arm, onAccept, onSignIn },
  ref,
) {
  const notice = resolveNotice(valid, arm)
  return (
    <Card ref={ref} collapse data-testid="join-preview">
      <Stack gap={5}>
        <Stack gap={2}>
          <Text role="ui-caption" as="p" data-testid="join-preview-eyebrow">
            {EYEBROW}
          </Text>
          <Heading level={1} role="title" data-testid="join-preview-campaign">
            {campaignName}
          </Heading>
          <Text role="meta" as="p" data-testid="join-preview-owner">
            {`${INVITED_BY} ${ownerName}`}
          </Text>
        </Stack>

        {notice !== null && (
          <Banner severity={notice.severity} data-testid="join-preview-notice">
            {notice.line}
          </Banner>
        )}

        {/* No CTA on an invalid preview — there is nothing to accept. */}
        {valid && (
          <Stack>
            {signedIn ? (
              <Button
                variant="primary"
                size="lg"
                loading={accepting}
                onPress={onAccept}
                data-testid="join-preview-accept"
              >
                {ACCEPT_CTA}
              </Button>
            ) : (
              <Button variant="primary" size="lg" onPress={onSignIn} data-testid="join-preview-signin">
                {SIGNIN_CTA}
              </Button>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  )
})
