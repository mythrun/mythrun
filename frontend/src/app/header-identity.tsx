import { Text } from '@mythrun/ui'
import { useMe } from '@mythrun/client-core'
import { HeaderSlot } from './header-slot.tsx'

// The header identity slot (MYT-99). Renders the signed-in player's REAL display
// name — read from `useMe()` (GET /api/users/me) — as a terse mono chip in the app
// frame. This replaces the passthrough i18n key `frame.displayName` = "{{displayName}}",
// which the header rendered with no interpolation values and so printed the literal
// token "{{DISPLAYNAME}}" (uppercased by the old ui-label role). The name is DATA, not
// copy, so it is rendered from the API directly rather than through the catalog.
//
// Like the credits slot it lives in the ALWAYS-present frame, so `HeaderSlot`
// isolates it: it appears once `useMe` resolves (no spinner — the name simply fills
// in) and degrades to nothing if the fetch fails. AppFrame only ever mounts under
// <RequireAuth>, so `useMe` is always authed here.
//
// The name is the ONLY flexible item in the header row: `truncate` makes a long
// name ellipsize and absorb the row's shrink (the wordmark, credits, and action
// buttons hold their width), so a long name can never squeeze the fixed chrome.
// AppFrame renders it inside a `<Show above="sm">`, so the name is HIDDEN on
// phones (< 640px) — the considered mobile arrangement gives the essential
// wordmark · balance · actions room to breathe instead of squeezing the name to a
// two-letter stub. It is rendered as a block `<p>` (not the default inline span) so
// that, inside the Show wrapper, `truncate` still ellipsizes a long name on desktop.

/** The resolved display name. Only rendered once `useMe` has data (HeaderSlot's
 *  Suspense owns the loading state, its error boundary the failure). */
function HeaderIdentityValue(): React.JSX.Element {
  const { data } = useMe()
  return (
    <Text as="p" role="data" truncate data-testid="frame-display-name">
      {data.user.displayName}
    </Text>
  )
}

/** The header identity slot: the live display name, resilient to a slow or failed
 *  `/me` fetch (appears when ready, degrades to empty on error). */
export function HeaderIdentity(): React.JSX.Element {
  return (
    <HeaderSlot>
      <HeaderIdentityValue />
    </HeaderSlot>
  )
}
