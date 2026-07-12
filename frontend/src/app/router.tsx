import { lazy, Suspense } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import type { RouteObject } from 'react-router-dom'
import { Spinner } from '@mythrun/ui'
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
import { CampaignDetailRoute } from '../routes/campaign-detail.tsx'
import { CharacterNewRoute } from '../routes/character-new.tsx'
import { SituationPickRoute } from '../routes/worldgen/situation-pick.tsx'
import { LevelPickRoute } from '../routes/character-new/level-pick.tsx'
import { JoinSummaryRoute } from '../routes/character-new/join-summary.tsx'
import { PlayRoute } from '../routes/play.tsx'
import { SettingsRoute } from '../routes/settings.tsx'

// DEV-only realtime-transport harness (MYT-85 T9). React.lazy over a
// DEV-STATIC dynamic import: in a prod build `import.meta.env.DEV` is a
// statically-`false` constant, so this whole expression — and the
// `import('../routes/dev-transport.tsx')` inside it — dead-code-eliminates, and
// the harness ships as a SEPARATE chunk that never enters the prod bundle.
// (Gating only the route ARRAY would still bundle the import; the static-DEV
// `lazy(() => import(...))` is what tree-shakes the chunk.) `React.lazy` wants a
// module with a `default` export, but the repo bans default exports — so map the
// named export through a `{ default }` shim.
const DevTransportRoute = import.meta.env.DEV
  ? lazy(() =>
      import('../routes/dev-transport.tsx').then((m) => ({ default: m.DevTransportRoute })),
    )
  : undefined

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
// The tree is built as a plain `RouteObject[]` so tests drive the SAME array
// through `createMemoryRouter`, and the app mounts it through
// `createBrowserRouter` in <AppRouter>. Every screen but the home hub is a thin
// i18n'd stub the flow tickets fill (R5); W3e wires /home end-to-end.
//
// `errorElement` on the root catches a thrown render/loader failure anywhere in
// the tree and branches on the data layer's typed errors (§3).
//
// `buildRoutes(dev)` takes the dev flag (not a direct `import.meta.env.DEV` read)
// so the wiring test can assert the harness route is PRESENT in a dev tree and
// ABSENT in a prod tree without a real prod build. The shipped `routes` resolves
// the flag from the build env.
export function buildRoutes(dev: boolean): RouteObject[] {
  // The DEV-only harness route — appended ONLY in a dev build (and only when the
  // lazy component survived the static-DEV guard above). A prod build omits it.
  const devRoutes: RouteObject[] =
    dev && DevTransportRoute
      ? [
          {
            path: 'dev/transport',
            element: (
              <Suspense fallback={<Spinner />}>
                <DevTransportRoute />
              </Suspense>
            ),
          },
        ]
      : []

  return [
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
                // The home-hub card's click target. Static `campaigns/new` outranks
                // this dynamic `:id` (RR ranks static segments above dynamic), so
                // `/campaigns/new` still resolves to CampaignNewRoute; a real
                // campaign id lands here instead of falling through to the 404.
                { path: 'campaigns/:id', element: <CampaignDetailRoute /> },
                // The starting-situation pick (D4) — where the reveal's Continue
                // leads. Static `campaigns/new` still outranks `:id`; this deeper
                // static tail sits under the same `:id` space.
                { path: 'campaigns/:id/situation', element: <SituationPickRoute /> },
                { path: 'campaigns/:id/level', element: <LevelPickRoute /> },
                { path: 'campaigns/:id/join', element: <JoinSummaryRoute /> },
                { path: 'campaigns/:id/character/new', element: <CharacterNewRoute /> },
                { path: 'campaigns/:id/play', element: <PlayRoute /> },
                { path: 'settings', element: <SettingsRoute /> },
              ],
            },
          ],
        },

        // ---- DEV-only transport harness (omitted in prod) ----
        ...devRoutes,

        // ---- Catch-all: the dithered 404 ----
        { path: '*', element: <NotFound /> },
      ],
    },
  ]
}

// The shipped route tree (dev flag resolved from the build env).
export const routes: RouteObject[] = buildRoutes(import.meta.env.DEV)

// The app's concrete router: the route tree over the browser history. Built once
// at module scope (a fresh router on every render would drop navigation state).
const browserRouter = createBrowserRouter(routes)

/** Mounts the app route tree over browser history. The web entry renders this. */
export function AppRouter(): React.JSX.Element {
  return <RouterProvider router={browserRouter} />
}
