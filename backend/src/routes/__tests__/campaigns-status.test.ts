// backend/src/routes/__tests__/campaigns-status.test.ts
//
// Integration tests for the campaigns status + SSE stream routes. The
// real assertions are deferred to MYT-50 T7 (`app.ts` wiring) because
// T6 only adds the routes plugin; without `buildApp` registering it, an
// `app.inject(...)` call would 404. Writing a parallel test-only Fastify
// boot would duplicate the entire auth + rate-limit + access-control
// chain, which is itself the surface the tests need to exercise.
//
// The placeholder `describe.skip` keeps the test file present (so the
// CI grep for `routes/__tests__/campaigns-status.test.ts` doesn't fail
// later) without contributing red runs. T7 replaces this skip with the
// 4 integration tests from the plan §Task 6 Step 1:
//
//   1. GET /api/campaigns/:campaignId/status returns 200 + snapshot for member
//   2. GET /api/campaigns/:campaignId/status returns 403 for non-member
//   3. GET .../status/stream returns text/event-stream + initial snapshot frame
//   4. SSE stream forwards a published phase event
//
// Plan reference:
// docs/superpowers/plans/2026-05-12-myt-50-pipeline-status-surface.md
// (Task 6, Step 1).

import { describe, it } from 'vitest'

// TODO(MYT-50 T7): replace this skip with the real integration tests once
// `app.ts` registers `campaignsRoutes` + constructs the
// PipelineSubscriber + ConnectionCounter. The plan's snippet uses
// `buildApp(...)` against real Postgres + Redis (DATABASE_URL +
// REDIS_REALTIME_URL), seeds a campaign + member via raw SQL, then
// asserts snapshot + SSE behavior.
describe.skip('campaigns status routes (deferred to MYT-50 T7)', () => {
  it('placeholder — see test file header for the T7 work list', () => {
    // intentionally empty
  })
})
