import { useQuery } from '@tanstack/react-query'
import { getMe, useApiContext } from '@mythrun/client-core'

// The frame's identity data path (navbar redesign) — the old <HeaderIdentity/>
// slot lifted into a VALUE: the display name now lives ON the desktop menu
// trigger, so AppFrame needs a string to hand to <HeaderMenu/>, not a rendered
// row. Same `['me']` cache as `useMe` (one entry, one fetch — the harness's
// seedMe keeps working), but read through a NON-suspense query: the old slot's
// HeaderSlot Suspense + error boundary can't wrap a hook, so its boundary
// semantics are restated as status flags — `null` while the fetch is in flight
// AND after a failure. HeaderMenu maps null to the labeled icon trigger on both
// arrangements, so Log out stays reachable during a cold /me fetch and a failed
// fetch degrades the trigger instead of throwing into the route error boundary.

/** The signed-in player's display name, or `null` while /me loads or failed. */
export function useHeaderDisplayName(): string | null {
  const ctx = useApiContext()
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () => getMe(undefined, ctx),
  })
  return data?.user.displayName ?? null
}
