import { forwardRef } from 'react'
import type { JoinPreviewProps, JoinPreviewLabels, AcceptArmKind, Severity } from '@mythrun/client-core/contract'
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
// COPY — the display strings (the eyebrow, the "invited by" prefix, the two CTAs,
// and every calm-notice line) arrive resolved via `labels` (MYT-100 lifted them into
// the contract, same pattern as PartyRoster / CharacterLoadingBeat; the DS owns no
// copy). Only the campaign name + owner (real data) arrive as their own props.

interface ArmNotice {
  readonly severity: Severity
  readonly line: string
}

// The Banner severity per post-accept arm — the DS keeps the severity mapping (the
// line body arrives via `labels`). Severity keeps the register calm: the terminal
// soft-blocks are advisory `info`; the transient failures worth a retry are
// `warning`. No arm is `danger` — a failed join is never a red alarm.
const ARM_SEVERITY: Record<AcceptArmKind, Severity> = {
  full: 'info',
  revoked: 'info',
  gone: 'info',
  'not-found': 'info',
  timeout: 'warning',
  error: 'warning',
}

/** The resolved notice line for a post-accept arm (maps the hyphenated arm id to
 *  its camelCase label field). */
function armLine(arm: AcceptArmKind, labels: JoinPreviewLabels): string {
  switch (arm) {
    case 'full':
      return labels.full
    case 'revoked':
      return labels.revoked
    case 'gone':
      return labels.gone
    case 'not-found':
      return labels.notFound
    case 'timeout':
      return labels.timeout
    case 'error':
      return labels.error
  }
}

// The calm notice to surface, if any: the invalid-preview state takes precedence
// over a post-accept arm (an invalid invite can't have been accepted).
function resolveNotice(valid: boolean, arm: AcceptArmKind | null, labels: JoinPreviewLabels): ArmNotice | null {
  if (!valid) return { severity: 'info', line: labels.invalid }
  if (arm !== null) return { severity: ARM_SEVERITY[arm], line: armLine(arm, labels) }
  return null
}

export const JoinPreview = forwardRef<HTMLDivElement, JoinPreviewProps>(function JoinPreview(
  { labels, campaignName, ownerName, valid, signedIn, accepting, arm, onAccept, onSignIn },
  ref,
) {
  const notice = resolveNotice(valid, arm, labels)
  return (
    <Card ref={ref} collapse data-testid="join-preview">
      <Stack gap={5}>
        <Stack gap={2}>
          <Text role="ui-caption" as="p" data-testid="join-preview-eyebrow">
            {labels.eyebrow}
          </Text>
          <Heading level={1} role="title" data-testid="join-preview-campaign">
            {campaignName}
          </Heading>
          <Text role="meta" as="p" data-testid="join-preview-owner">
            {`${labels.invitedBy} ${ownerName}`}
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
                {labels.accept}
              </Button>
            ) : (
              <Button variant="primary" size="lg" onPress={onSignIn} data-testid="join-preview-signin">
                {labels.signin}
              </Button>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  )
})
