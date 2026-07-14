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

/** Props for the owner's InvitePanel — the single primary share link + copy /
 *  native-share / revoke. `inviteUrl` is null while loading or after a revoke with
 *  no fresh link yet. `notice` surfaces a calm cap/error line. */
export interface InvitePanelProps {
  inviteUrl: string | null
  loading: boolean
  /** navigator.share is available on this platform (the web wiring decides). */
  canShare: boolean
  /** A transient "copied" acknowledgement (the route owns the timer). */
  copied: boolean
  notice: 'cap-reached' | 'error' | null
  onCopy: () => void
  onShare: () => void
  onRevoke: () => void
  /** Mint a fresh link when none exists (post-revoke). */
  onCreate: () => void
}

/** Props for the public JoinPreview on /join/:code. `valid` is the preview's own
 *  validity (a revoked/expired code previews `valid:false`); `arm` is the
 *  post-accept calm-notice arm (null until a failed accept). `ownerName` is a
 *  plain string — the shipped preview reads `users.display_name` (TEXT NOT NULL)
 *  off an INNER JOIN, so there is no null/fallback case. */
export interface JoinPreviewProps {
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
