// Prop contracts + arm vocabulary for the invite/join surface (MYT-91).
// Platform-neutral (§9): callbacks are plain functions, never DOM events; every
// decided boolean (owner gating, share availability, signed-in) arrives already
// resolved. Type-only — no runtime values (the contract barrel is asserted
// keyless by contract.test.ts).

/** The calm-notice arm a failed *accept* resolves to (see `mapAcceptError`). Each
 *  value keys off one of the accept endpoint's typed error codes; `error` is the
 *  catch-all for an unknown code or a non-HTTP failure. */
export type AcceptArmKind = 'full' | 'revoked' | 'gone' | 'not-found' | 'timeout' | 'error'

/** The fork a failed *preview* resolves to (see `mapPreviewError`). A revoked or
 *  expired code is NOT an error — the preview endpoint resolves 200 with
 *  `valid:false` for those, surfaced through `JoinPreviewProps.valid`. A preview
 *  *throw* means either the code never existed (404 `invite_not_found` →
 *  `invalid`, a terminal calm notice — retrying is pointless) or a transient
 *  failure (network / 5xx → `error`, offer retry). */
export type PreviewArmKind = 'invalid' | 'error'

/** The InvitePanel's resolved chrome copy (the shell resolves i18n and passes it;
 *  MYT-100 — the DS owns no copy). The `limit`/`error` lines are the calm-notice
 *  bodies (keyed 1:1 to `campaign.invite.limit`/`.error`); the component maps the
 *  `notice: 'cap-reached'` arm to `limit`. Banner severity stays DS-side. */
export interface InvitePanelLabels {
  /** The panel eyebrow heading (e.g. "Invite"). */
  panelHeading: string
  /** The evocative hint under the panel eyebrow. */
  hint: string
  /** The line shown while the invite link is being prepared. */
  loading: string
  /** The line shown when no active link exists (offering create). */
  noLink: string
  /** The read-only link field's SR-only label (e.g. "Invite link"). */
  linkLabel: string
  /** The create-a-link CTA (shown when no active link exists). */
  create: string
  /** The copy-link control's default label. */
  copy: string
  /** The copy control's transient "copied" acknowledgement. */
  copied: string
  /** The native-share control's label. */
  share: string
  /** The replace-link control's label. */
  replace: string
  /** The one-beat confirm prompt shown after Replace is pressed (it strands the old
   *  link, so the destructive step is confirmed before it fires). */
  replacePrompt: string
  /** The confirm control that actually replaces the link. */
  replaceConfirm: string
  /** The cancel control that keeps the current link. */
  replaceCancel: string
  /** The `cap-reached` calm-notice body (the soft invite-limit line). */
  limit: string
  /** The `error` calm-notice body (the transient-failure line). */
  error: string
}

/** Props for the owner's InvitePanel — the single primary share link + copy /
 *  native-share / revoke. `inviteUrl` is null while loading or after a revoke with
 *  no fresh link yet. `notice` surfaces a calm cap/error line. */
export interface InvitePanelProps {
  /** The resolved chrome copy (the shell resolves i18n and passes it). */
  labels: InvitePanelLabels
  inviteUrl: string | null
  loading: boolean
  /** navigator.share is available on this platform (the web wiring decides). */
  canShare: boolean
  /** A transient "copied" acknowledgement (the route owns the timer). */
  copied: boolean
  notice: 'cap-reached' | 'error' | null
  /** Visual weight (MYT-99g03). `primary` fills Copy in the brand accent (the
   *  campaign hub, where the invite IS the primary action). `quiet` renders Copy as
   *  a bordered secondary so a DEMOTED invite (below a character reveal / party
   *  roster) never out-shouts that screen's real primary action. Defaults to
   *  `primary`. */
  prominence?: 'primary' | 'quiet'
  onCopy: () => void
  onShare: () => void
  /** Replace the current link (revoke + re-mint). Fired only AFTER the panel's
   *  one-beat confirm — Replace strands any already-shared link, so it never fires
   *  on the first press. */
  onRevoke: () => void
  /** Mint a fresh link when none exists (post-revoke). */
  onCreate: () => void
}

/** The JoinPreview's resolved chrome copy (the shell resolves i18n and passes it;
 *  MYT-100 — the DS owns no copy). The `full`…`error` lines are the calm-notice
 *  bodies, one per {@link AcceptArmKind} (plus `invalid` for the revoked/expired
 *  preview); their Banner severity stays DS-side. */
export interface JoinPreviewLabels {
  /** The "you've been invited" eyebrow. */
  eyebrow: string
  /** The quiet "invited by" prefix (the owner name is interpolated after it). */
  invitedBy: string
  /** The signed-in accept CTA. */
  accept: string
  /** The signed-out "sign in to join" CTA. */
  signin: string
  /** The calm notice for a revoked/expired preview (`valid:false`). */
  invalid: string
  /** The `full` arm calm-notice body. */
  full: string
  /** The `revoked` arm calm-notice body. */
  revoked: string
  /** The `gone` arm calm-notice body. */
  gone: string
  /** The `not-found` arm calm-notice body. */
  notFound: string
  /** The `timeout` arm calm-notice body. */
  timeout: string
  /** The `error` arm calm-notice body. */
  error: string
}

/** Props for the public JoinPreview on /join/:code. `valid` is the preview's own
 *  validity (a revoked/expired code previews `valid:false`); `arm` is the
 *  post-accept calm-notice arm (null until a failed accept). `ownerName` is a
 *  plain string — the shipped preview reads `users.display_name` (TEXT NOT NULL)
 *  off an INNER JOIN, so there is no null/fallback case. */
export interface JoinPreviewProps {
  /** The resolved chrome copy (the shell resolves i18n and passes it). */
  labels: JoinPreviewLabels
  campaignName: string
  ownerName: string
  valid: boolean
  signedIn: boolean
  accepting: boolean
  arm: AcceptArmKind | null
  /** Signed-in accept path. */
  onAccept: () => void
  /** Signed-out path — route to the guarded sign-in returnTo. */
  onSignIn: () => void
}
