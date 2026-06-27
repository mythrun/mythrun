import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import type { RouteObject } from 'react-router-dom'
import { RequireAuth } from './require-auth.tsx'
import { AppFrame } from './app-frame.tsx'
import { NotFound } from './not-found.tsx'
import { RouteErrorBoundary } from './error-boundary.tsx'
import { LandingRoute } from '../routes/landing.tsx'
import { SigninRoute } from '../routes/signin.tsx'
import { CallbackRoute } from '../routes/callback.tsx'
import { OnboardRoute } from '../routes/onboard.tsx'
import { JoinRoute } from '../routes/join.tsx'
import { RecapRoute } from '../routes/recap.tsx'
import { HomeRoute } from '../routes/home.tsx'
import { CampaignNewRoute } from '../routes/campaign-new.tsx'
import { CharacterNewRoute } from '../routes/character-new.tsx'
import { PlayRoute } from '../routes/play.tsx'
import { SettingsRoute } from '../routes/settings.tsx'

// The application route tree — the skeleton every flow hangs on (spec §4). Two
// branches under one root error boundary:
//
//   PUBLIC   resolve pre-auth: the landing page, the auth screens (sign-in,
//            OAuth callback, onboarding), the invite-join link, the shareable
//            recap.
//   AUTHED   gated by <RequireAuth> (the three-state session check) → rendered
//            inside <AppFrame> (the quiet brand frame, an <Outlet/> layout
//            route): the home hub + the campaign/character/play/settings flows.
//
//   *        any unmatched path → the dithered 404.
//
// The tree is exported as a plain `RouteObject[]` so tests drive the SAME array
// through `createMemoryRouter`, and the app mounts it through
// `createBrowserRouter` in <AppRouter>. Every screen but the home hub is a thin
// i18n'd stub the flow tickets fill (R5); W3e wires /home end-to-end.
//
// `errorElement` on the root catches a thrown render/loader failure anywhere in
// the tree and branches on the data layer's typed errors (§3).
export const routes: RouteObject[] = [
  {
    errorElement: <RouteErrorBoundary />,
    children: [
      // ---- Public branch ----
      { index: true, element: <LandingRoute /> },
      { path: 'auth/signin', element: <SigninRoute /> },
      { path: 'auth/callback', element: <CallbackRoute /> },
      { path: 'auth/onboard', element: <OnboardRoute /> },
      { path: 'join/:code', element: <JoinRoute /> },
      { path: 'campaigns/:id/recap', element: <RecapRoute /> },

      // ---- Authed branch: RequireAuth gate → AppFrame layout ----
      {
        element: <RequireAuth />,
        children: [
          {
            element: <AppFrame />,
            children: [
              { path: 'home', element: <HomeRoute /> },
              { path: 'campaigns/new', element: <CampaignNewRoute /> },
              { path: 'campaigns/:id/character/new', element: <CharacterNewRoute /> },
              { path: 'campaigns/:id/play', element: <PlayRoute /> },
              { path: 'settings', element: <SettingsRoute /> },
            ],
          },
        ],
      },

      // ---- Catch-all: the dithered 404 ----
      { path: '*', element: <NotFound /> },
    ],
  },
]

// The app's concrete router: the route tree over the browser history. Built once
// at module scope (a fresh router on every render would drop navigation state).
const browserRouter = createBrowserRouter(routes)

/** Mounts the app route tree over browser history. The web entry renders this. */
export function AppRouter(): React.JSX.Element {
  return <RouterProvider router={browserRouter} />
}
