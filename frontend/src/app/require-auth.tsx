import { Navigate, Outlet } from 'react-router-dom'
import { useSessionStore } from '@mythrun/client-core'

// The three-state auth gate the whole authed tree hangs on. It reads ONLY the
// session store's `status` (the client brain's single source of truth, R1) and
// resolves it to one of three outcomes — no token parsing, no backend call, no
// local intelligence:
//
//   unauthenticated     → bounce to sign-in (no identity yet)
//   onboarding-required → bounce to onboarding (identity known, profile not)
//   ready               → render the matched authed route (<Outlet/>)
//
// The two backend rejections the client must tell apart (401 unauthenticated vs
// 403 username_required) map onto the first two states; MYT-84 fills the
// acquisition + onboarding flows behind those redirects. `replace` keeps the
// pre-auth URL out of history so Back doesn't loop through the gate.
export function RequireAuth(): React.JSX.Element {
  const status = useSessionStore((s) => s.status)

  if (status === 'unauthenticated') {
    return <Navigate to="/auth/signin" replace />
  }
  if (status === 'onboarding-required') {
    return <Navigate to="/auth/onboard" replace />
  }
  return <Outlet />
}
