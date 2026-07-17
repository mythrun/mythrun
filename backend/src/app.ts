import { randomUUID } from 'node:crypto'
import type { Server, IncomingMessage, ServerResponse } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import fastifyWebsocket from '@fastify/websocket'
import type { Pool } from 'pg'
import type { Redis } from 'ioredis'
import type { AppDeps } from './app-deps.js'
import { registerAuth, type RegisterAuthOptions } from './auth/index.js'
import { accessControlAllowlist } from './auth/access-control-allowlist.js'
import { registerPublicRouteAllowlistHook } from './auth/public-route-allowlist.js'
import { typedErrorHandler } from './error-handler.js'
import { requireOnboarded } from './auth/require-onboarded.js'
import type { Env } from './config/env.js'
import { registerReadyRoute } from './routes/health-ready.js'
import { usersRoutes } from './routes/users.js'
import { invitesRoutes } from './routes/invites.js'
import { sessionsRoutes } from './routes/sessions.js'
import { webhookRoutes } from './routes/webhook.js'
import { billingRoutes } from './routes/billing.js'
import { campaignsRoutes } from './routes/campaigns.js'
import { campaignPreviewRoutes } from './routes/campaign-preview.js'
import { campaignPreviewStreamRoutes } from './routes/campaign-preview-stream.js'
import { authRoutes } from './routes/auth.js'
import { createCognitoOAuthClient } from './auth/cognito-oauth-client.js'
import { campaignCharactersPlugin } from './routes/campaign-characters.js'
import { sessionPrepsPlugin } from './routes/session-preps.js'
import { worldgenRoutes } from './routes/worldgen.js'
import { devCreditsRoutes } from './routes/dev-credits.js'
import { devFireTurnRoutes } from './routes/dev-fire-turn.js'
import { devPrepProseRoutes } from './routes/dev-prep-prose.js'
import { devApiCostRoutes } from './routes/dev-api-cost.js'
import { PIPELINE_ROUTES } from './contract/pipeline-routes.js'
import { createPipelineSubscriber, type PipelineSubscriber } from './sse/pipeline-subscriber.js'
import { createConnectionCounter } from './sse/connection-counter.js'
import { wsSessionRoutes, WS_MAX_PAYLOAD_BYTES } from './routes/ws-session.js'
import { createSessionHub, type SessionHub } from './ws/session-hub.js'
import { makeSessionState } from './redis/session-state.js'
import { makeTriggerState } from './session/trigger-state.js'
import { createTurnPublisher } from './session/turn-publisher.js'
import { createSessionLock } from './session/session-lock.js'
import type { Logger as PinoLogger } from 'pino'

export interface AppConfig {
  /** Origin of the frontend SPA, used to compose share URLs (e.g. invite links).
   *  Validated by loadEnv() against an allowlist of hosts. Pass through
   *  intact — handlers concatenate paths onto it without re-validation. */
  readonly frontendBaseUrl: string
  /** Loaded process env. Threaded into the webhook + billing plugins so
   *  they can pull stripeSecretKey / stripeWebhookSecret without
   *  reaching back into module-level config. */
  readonly env: Env
}

/** Fastify module augmentation: buildApp `decorate`s the FastifyInstance
 *  with the MYT-50 pipeline subscriber + the connection-counter's
 *  periodic-log clearer. Both have app-scoped lifetime and need to be
 *  reachable from createShutdown's ShutdownClients (constructed in
 *  server.ts) — decorating keeps buildApp's return signature a plain
 *  FastifyInstance so the dozen existing test callers don't have to
 *  destructure, while still exposing the cross-boundary state. */
declare module 'fastify' {
  interface FastifyInstance {
    mythrunSubscriber: PipelineSubscriber
    mythrunStopPeriodicLog: () => void
    /** MYT-62 T5: dedicated `prep`-channel prose subscriber behind the
     *  dev-only GET /api/dev/campaigns/:campaignId/prep-prose route. OPTIONAL
     *  because it is constructed ONLY in the bypass block (authMode ===
     *  'bypass') — it is absent on a production boot. server.ts's shutdown
     *  closes it only when present. */
    mythrunProseSubscriber?: PipelineSubscriber
    /** MYT-65 Task 11: the cross-container WS fan-out hub. Owns a DEDICATED
     *  PSUBSCRIBE'd duplicate of redisRealtime, so — like mythrunSubscriber —
     *  it must be closed BEFORE app.close (its `close()` PUNSUBSCRIBEs + QUITs
     *  the dedicated client + clears the registry). Decorated here so
     *  createShutdown can reach it without widening the fixed ShutdownClients
     *  struct (same decoration pattern as mythrunProseSubscriber). */
    mythrunSessionHub: SessionHub
  }
}

/** MYT-74a T11: TTL (ms) on the per-session lock the `end_session` flow uses to
 *  QUIESCE the in-flight turn. Mirrors the turn worker's SESSION_LOCK_TTL_MS
 *  (45s) so the end-flow fence shares the live turn's lock semantics; the end
 *  only holds it briefly across the row flip, then releases. */
const WS_END_LOCK_TTL_MS = 45_000

// buildApp is the boot orchestrator: a flat, top-to-bottom registration
// sequence where the ORDER is load-bearing (allowlist hook before
// /health, webhook plugin before usersRoutes, billingRoutes last).
// Splitting it into helpers would scatter the order-dependence across
// files and obscure the wiring contract this function exists to express.
export const buildApp = async (
  deps: AppDeps,
  authOpts: RegisterAuthOptions,
  config: AppConfig,
): Promise<FastifyInstance> => {
  // Explicit type parameters force selection of the plain-HTTP Fastify
  // overload. Without them, TS picks the first matching overload
  // (Http2SecureServer), which then propagates incompatible RawServer
  // types into hooks/plugins that expect the default.
  const app = Fastify<Server, IncomingMessage, ServerResponse>({
    // ALB → ECS: trust exactly one proxy hop so request.ip / hostname read
    // X-Forwarded-* with the real client values, not the ALB's. Required for
    // accurate rate-limit keys and for routes that log/use request.ip.
    trustProxy: 1,
    // CRITICAL: Fastify's default pluginTimeout is 10s. Our jwtPlugin's
    // hydrate has up-to-1s jitter + 10s timeout = 11s wall budget. Without
    // the bump, Fastify's pluginTimeout fires first on slow Cognito and
    // the operator sees a generic Fastify timeout instead of our specific
    // auth.jwks_hydrate_failed log line. Bump to 30s.
    pluginTimeout: 30_000,
    genReqId: (req) => {
      const trace = req.headers['x-amzn-trace-id']
      /* c8 ignore start — randomUUID fallback fires only when the
       * ALB header is absent; production traffic always carries it and
       * test traffic is generated via inject() without setting it. The
       * falsy arm is defense-in-depth for non-ALB callers. */
      return typeof trace === 'string' ? trace : randomUUID()
      /* c8 ignore stop */
    },
    logger: {
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
      /* c8 ignore start — pino's req serializer fires only when a log
       * call actually serializes `req`. Fastify's built-in request log
       * is suppressed in test env (disableRequestLogging is on for our
       * test logger), so this body is structurally unreachable in unit
       * coverage. The behavior is verified by the redaction + URL-strip
       * specs in production logs. */
      serializers: {
        req(request) {
          // Strip query strings from logged URLs so future routes that
          // take tokens via query (notably MYT-39's WebSocket
          // ?ticket=<nonce>) don't leak the token into CloudWatch.
          // Path is preserved so operators can tell which route was hit.
          const rawUrl: unknown = request.url
          const url = typeof rawUrl === 'string' ? (rawUrl.split('?')[0] ?? rawUrl) : undefined
          const remotePort = request.socket.remotePort
          // Build the result with conditional spread so we don't emit
          // explicit `undefined` properties — exactOptionalPropertyTypes
          // forbids `url: undefined` against a `url?: string` signature.
          return {
            method: request.method,
            ...(url !== undefined ? { url } : {}),
            hostname: request.hostname,
            remoteAddress: request.ip,
            ...(remotePort !== undefined ? { remotePort } : {}),
          }
        },
      },
      /* c8 ignore stop */
    },
  })

  // Public-route allowlist hook (MYT-42 task 11 + spec §3 lines 86–109).
  // MUST be installed BEFORE any route registration that may set
  // `config.auth: 'public'` — Fastify's onRoute hook is inherited downward
  // only into plugins/routes registered AFTER the hook is added on the
  // same scope. Hoisting this above `/health` is load-bearing: if the
  // hook is registered after /health, the hook never validates the
  // /health registration and a future addition of a public route there
  // would silently slip through.
  registerPublicRouteAllowlistHook(app)

  // Pipeline-routes contract enforcement (MYT-51 D12 revised). The forward
  // check (onRoute) catches a route registered with config.pipelineRoute=true
  // that is NOT declared in PIPELINE_ROUTES; the reverse check (onReady)
  // catches an entry in PIPELINE_ROUTES that no route ever registered.
  //
  // APPROVED_VERBS filters HEAD/OPTIONS — Fastify auto-generates HEAD for
  // every GET, and the auto-HEAD inherits config (including pipelineRoute)
  // from its parent GET; counting it would double-register the key.
  //
  // The hook is installed on the root scope BEFORE any plugin registration,
  // so Fastify's downward-inheritance contract picks up every subsequent
  // route registration in any nested plugin.
  const APPROVED_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  const registeredPipelineRoutes = new Set<string>()
  app.addHook('onRoute', (routeOptions) => {
    if (routeOptions.config?.pipelineRoute !== true) return
    /* c8 ignore start — defense-in-depth: Fastify allows `method` as a
     * string or string[], but every pipelineRoute=true registration in
     * this codebase passes a single HTTP verb string. The array arm is
     * a future-proofing fall-through for the multi-verb registration
     * shape we don't currently use. */
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method]
    /* c8 ignore stop */
    for (const m of methods) {
      if (!APPROVED_VERBS.has(m)) continue
      const key = `${m} ${routeOptions.url}`
      registeredPipelineRoutes.add(key)
      if (!PIPELINE_ROUTES.includes(key)) {
        throw new Error(
          `pipeline-routes: ${key} is registered with config.pipelineRoute=true but is not ` +
            `declared in contract/pipeline-routes.ts. Add it to PIPELINE_ROUTES or remove ` +
            `the marker.`,
        )
      }
    }
  })
  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onReady', async () => {
    const missing = PIPELINE_ROUTES.filter((k) => !registeredPipelineRoutes.has(k))
    if (missing.length > 0) {
      throw new Error(
        `pipeline-routes: declared in contract/pipeline-routes.ts but no route ever registered ` +
          `with config.pipelineRoute=true matching: ${missing.join(', ')}. Either register the ` +
          `route with the marker or remove the entry from PIPELINE_ROUTES.`,
      )
    }
  })

  // CORS (cross-origin SPA → API). The prod topology is a SEPARATE api.mythrun.com
  // with real CORS — NOT a dev proxy (that pattern stays confined to the internal
  // dev-tool). The SPA (app.mythrun.com / dev localhost:5173) calls this API on a
  // different origin, so the browser preflights non-simple requests and the API
  // must echo an explicit Access-Control-Allow-Origin. The one allowed origin IS
  // the frontend SPA origin — config.env.frontendBaseUrl, already validated +
  // host-allowlisted by loadEnv (dev http://localhost:5173; staging/prod the
  // deployed SPA host). Reusing it keeps ONE source of truth for "where the
  // frontend lives" — no parallel CORS allowlist to drift.
  //
  // Registered HERE, ahead of registerAuth, so the cors onRequest hook runs first:
  // a preflight OPTIONS short-circuits (204) before the auth hook would reject the
  // un-credentialed preflight.
  await app.register(cors, {
    origin: [config.env.frontendBaseUrl],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-mythrun-dev-sub'],
    // MYT-84: cookie-based refresh has landed — credentials:true so the browser
    // sends the httpOnly mythrun_refresh cookie on the credentialed /api/auth/*
    // fetches. Origin stays the single explicit frontendBaseUrl (never '*').
    credentials: true,
  })

  app.get('/health', { config: { auth: 'public' } }, () => ({ status: 'ok' })) // liveness
  registerReadyRoute(app, deps) // /health/ready opts out via config: { auth: 'public' } INSIDE the route file

  // Custom 404 handler so unmatched paths return a stable JSON shape
  // instead of Fastify's default HTML-ish error. The auth hook's
  // `request.routeOptions.url === undefined` guard (in bypass-plugin.ts +
  // jwt-plugin.ts) already short-circuits auth for the 404 path —
  // Fastify v5's setNotFoundHandler opts only support preValidation /
  // preHandler hooks, not per-route config, so the v4-style
  // `{ config: { auth: 'public' } }` belt-and-suspenders isn't expressible
  // here. The url-undefined guard is the actual contract.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not Found' })
  })

  // Typed-error → typed-response mapper. The Vercel SDK middleware
  // (backend/src/llm/middleware.ts) already maps raw AI_APICallError
  // chains into Mythrun-typed error classes (LlmAuthError,
  // LlmRateLimitedError, etc.). This handler is the second half: it
  // translates those typed errors into HTTP responses that match
  // PipelineRouteError's discriminated union, so the FE never sees
  // an untyped 500 from an upstream LLM failure.
  //
  // Application-level typed errors (InsufficientCreditsError, etc.)
  // stay inline in their route handlers — those carry route-specific
  // payload (creditType, etc.) that the global handler can't compose.
  app.setErrorHandler(typedErrorHandler)

  await registerAuth(app, authOpts)

  // Rate-limit plugin — global=false so individual routes opt in via
  // config.rateLimit. The 1000/min ceiling is a safety net only; per-route
  // limits set tighter caps (e.g. /api/users/register = 5/min).
  //
  // Backed by redisRealtime so the limit applies across the ECS fleet,
  // not per-task. Default keyGenerator returns request.ip (the real
  // client because trustProxy: 1 strips the ALB hop). Routes that need
  // per-sub limiting override via config.rateLimit.keyGenerator.
  //
  // Fails OPEN if Redis is unreachable: @fastify/rate-limit's default
  // skipOnError logs the error and allows the request through. Trade-off
  // accepted — rate-limit infra failure should not 503 the service.
  await app.register(rateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
    redis: deps.redisRealtime,
    nameSpace: `${deps.redisKeyPrefix}rl:`,
  })

  // requireOnboarded gates protected routes on a real users row +
  // suspended_at check, attaches frozen request.dbUser. Public +
  // jwt-no-db opt out; jwt-no-db is allowlist-bound and boot fails if a
  // non-allowlisted route uses it.
  await app.register(requireOnboarded, { pool: deps.pg })

  // accessControlAllowlist (MYT-39 §4) — boot-time gate that fails
  // app.ready() if any route uses requireCampaignMember/requireWorldCreator
  // together with config.auth: 'public' or 'jwt-no-db' (which would
  // short-circuit requireOnboarded and leave request.dbUser undefined).
  // Registered AFTER requireOnboarded so the allowlist's onRoute hook
  // sees every subsequent route registration.
  await app.register(accessControlAllowlist)

  // MYT-84 BFF session endpoints (GAP-B). jwt-mode only: the cookie/refresh model
  // is staging/prod; dev runs bypass and never hits these. Registered after the
  // rate-limit plugin (so config.rateLimit applies) and after the public-route
  // allowlist hook (top of buildApp), which validates their config.auth:'public'.
  if (config.env.authMode === 'real') {
    const { cognitoHostedUiDomain, cognitoAppClientId } = config.env
    if (cognitoHostedUiDomain === undefined || cognitoAppClientId === undefined) {
      throw new Error('buildApp: authMode=real requires cognitoHostedUiDomain + cognitoAppClientId')
    }
    await app.register(cookie)
    await app.register(authRoutes, {
      cognito: createCognitoOAuthClient({
        hostedUiDomain: cognitoHostedUiDomain,
        clientId: cognitoAppClientId,
      }),
      frontendBaseUrl: config.frontendBaseUrl,
    })
  } else {
    // Bypass mode (MYT-102 audit): the SPA's on-load session probe still fires,
    // and a 404 paints a red console line on every dev page load. Answer the
    // Response200 way — 200 with a null body, the same "no session" shape the
    // real route gives an anonymous visitor. Probe-only; every other auth
    // endpoint stays real-mode-only.
    app.post('/api/auth/refresh', { config: { auth: 'public' } }, (_request, reply) =>
      reply.code(200).send(null),
    )
  }

  // Webhook plugin (MYT-42 Task 15). Registered BEFORE any sibling JSON
  // route the parent scope cares about, so the encapsulated raw-body
  // parser stays inside the child context (Fastify v5's
  // addContentTypeParser is encapsulation-scoped, not route-scoped — see
  // routes/webhook.ts for the full rationale).
  await app.register(webhookRoutes, { pool: deps.pg, env: config.env })

  await app.register(usersRoutes, { pool: deps.pg })
  await app.register(invitesRoutes, {
    pool: deps.pg,
    frontendBaseUrl: config.frontendBaseUrl,
  })

  // Sessions plugin (MYT-39 §6 + MYT-65 lifecycle). Mints ws-tickets, starts
  // sessions, serves /active + /messages. The WS upgrade route (below) is the
  // socket counterpart that the minted ticket authorizes.
  await app.register(sessionsRoutes, {
    pool: deps.pg,
    redisRealtime: deps.redisRealtime,
    redisKeyPrefix: deps.redisKeyPrefix,
  })

  // MYT-65 Task 11: the multiplayer WebSocket transport.
  //
  // @fastify/websocket is registered on the root scope BEFORE wsSessionRoutes
  // so the `{ websocket: true }` route option resolves. `maxPayload` is the
  // library-level oversized-frame guard (the in-handler MAX_MESSAGE_TEXT_LEN
  // cap is the second line of defense, see routes/ws-session.ts).
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } })

  // The hub owns a DEDICATED PSUBSCRIBE'd duplicate of redisRealtime (a
  // subscriber-mode client can't also publish/rate-limit). Constructed here —
  // not inside the plugin — because its lifetime is the app's lifetime: the
  // shutdown handler must PUNSUBSCRIBE + QUIT that client. app.log is a pino
  // Logger at runtime; cast at the boundary (same rationale as the pinoLog cast
  // for the pipeline subscriber below).
  const hub = await createSessionHub({
    redis: deps.redisRealtime,
    keyPrefix: deps.redisKeyPrefix,
    logger: app.log as PinoLogger,
  })
  // Expose to createShutdown (server.ts) via the module-augmented instance —
  // same decoration pattern as mythrunSubscriber / mythrunProseSubscriber.
  app.decorate('mythrunSessionHub', hub)

  // A stable per-process identity. Keys each connection's presence key
  // (`session:{cId}:conn:{containerId}:{userId}`) so a crashed container's
  // presence lapses via TTL rather than wedging the suspend logic on a stale
  // counter. Generated once per boot.
  const containerId = randomUUID()

  await app.register(wsSessionRoutes, {
    repo: deps.repo,
    sessionState: makeSessionState(deps.redisRealtime, deps.redisKeyPrefix),
    hub,
    suspendQueue: deps.sessionSuspendQueue,
    redisRealtime: deps.redisRealtime,
    redisKeyPrefix: deps.redisKeyPrefix,
    containerId,
    // MYT-67: the DM-trigger surface. The debounce queue (auto/solo quiet
    // window) + the session-turn queue (explicit direct-enqueue) + the trigger
    // Redis state + the cross-process turn publisher (immediate `dm_thinking`
    // on an explicit summon) all thread into the inbound handler.
    dmTriggerQueue: deps.dmTriggerQueue,
    sessionTurnQueue: deps.sessionTurnQueue,
    triggerState: makeTriggerState(deps.redisRealtime, deps.redisKeyPrefix),
    turnPublisher: createTurnPublisher(deps.redisRealtime, deps.redisKeyPrefix),
    // MYT-74a T11: the end-of-session reconcile producer + the per-session lock
    // the `end_session` flow uses to QUIESCE the in-flight turn. The lock is
    // built over the SAME realtime Redis + key prefix as the turn/reconcile
    // workers' locks (session:lock:{cId}), so the end-flow fence coordinates
    // with a live turn. TTL mirrors the turn worker's 45s — the end only holds
    // the lock briefly across the row flip, then releases.
    reconcileQueue: deps.sessionReconcileQueue,
    lock: createSessionLock(deps.redisRealtime, deps.redisKeyPrefix, WS_END_LOCK_TTL_MS),
  })

  // MYT-50: pipeline status surface. The subscriber owns a DEDICATED
  // duplicate of deps.redisRealtime that enters PSUBSCRIBE mode for
  // `${redisKeyPrefix}pipeline:campaign:*` — sharing the main realtime
  // client would deadlock subscriber-mode against rate-limit + ws-ticket
  // commands. The counter's periodic log is unref'd, so it doesn't pin
  // the event loop during shutdown, but we still clear it explicitly so
  // the final 60s window doesn't emit after subscriber.close().
  // Fastify v5's app.log is structurally a pino.Logger at runtime
  // (Fastify uses pino internally), but its declared FastifyBaseLogger
  // type omits pino-internal fields like `msgPrefix`. The subscriber +
  // counter constructors take pino.Logger strictly so their internal
  // call sites stay typesafe. Cast at the boundary — runtime is sound;
  // the type-system gap is purely declarational. Mirrors the cast in
  // routes/campaigns.ts where request.log crosses into openSseConnection.
  const pinoLog = app.log as PinoLogger
  const subscriber = createPipelineSubscriber(deps.redisRealtime, deps.redisKeyPrefix, pinoLog)
  const counter = createConnectionCounter(pinoLog)
  const stopPeriodicLog = counter.startPeriodicLog()
  // Expose to server.ts (createShutdown) via the module-augmented
  // FastifyInstance — see the `declare module 'fastify'` block above.
  app.decorate('mythrunSubscriber', subscriber)
  app.decorate('mythrunStopPeriodicLog', stopPeriodicLog)

  // Campaigns plugin (MYT-50). Registered after the access-control +
  // requireOnboarded chain so `/api/campaigns/:campaignId/status` +
  // `/status/stream` inherit the JWT + onboarded + per-campaign-membership
  // gates. The subscriber + counter are constructed here (not inside
  // the plugin) because their lifetime is the app's lifetime — the
  // shutdown handler needs to QUIT the dedicated client + clear the
  // counter interval, and the plugin scope can't expose those.
  await app.register(campaignsRoutes, {
    pool: deps.pg,
    subscriber,
    counter,
    // Single-origin CORS for the hijacked SSE responses (/status/stream,
    // /prep-status): @fastify/cors's onSend hook can't set the header on a
    // hijacked reply, so openSseConnection echoes it from the SAME allowlisted
    // origin the cors plugin is registered with above (config.env.frontendBaseUrl).
    frontendBaseUrl: config.env.frontendBaseUrl,
    // MYT-51 T12: thread the BullMQ queue + redis + key prefix so
    // POST /api/campaigns + POST /resume can enqueue work and the
    // rejection-storm counter can read/write its sliding-window key.
    // T9's runtime requireCreateRouteDeps() assertion becomes silent
    // dead code once this registration is in place — kept as belt-and-
    // suspenders against a future regression that drops one of the
    // three fields without updating the boot wiring.
    redis: deps.redisRealtime,
    redisKeyPrefix: deps.redisKeyPrefix,
    worldGenQueue: deps.worldGenQueue,
    // MYT-102: POST /resume's character_creation arm re-enqueues stuck
    // cc-<campaignId>-<userId> jobs — without this thread the arm answers
    // 503 queue_not_ready in every real deployment. Conditional spread per
    // exactOptionalPropertyTypes (matches the campaignCharactersPlugin idiom).
    ...(deps.characterCreationQueue !== undefined
      ? { characterCreationQueue: deps.characterCreationQueue }
      : {}),
  })

  // MYT-89 A3: guided world-creation preview. POST
  // /api/campaigns/synthesize-preview synthesizes + gates an original concept
  // and parks it in Redis under a previewId WITHOUT charging a credit (charged
  // later at commit). Registered after requireOnboarded, like campaignsRoutes,
  // so it inherits the JWT + onboarded gates. Its own focused plugin (keeps
  // campaigns.ts from growing).
  await app.register(campaignPreviewRoutes, {
    pool: deps.pg,
    redis: deps.redisRealtime,
    redisKeyPrefix: deps.redisKeyPrefix,
  })

  // myth-umggn: the STREAMED sibling of synthesize-preview. Same guards, same
  // gate, same parking — but the world brief arrives as a one-shot SSE stream
  // so the guided flow renders it writing itself. Needs frontendBaseUrl for
  // the hijacked SSE response's CORS echo (same as the status stream).
  await app.register(campaignPreviewStreamRoutes, {
    pool: deps.pg,
    redis: deps.redisRealtime,
    redisKeyPrefix: deps.redisKeyPrefix,
    frontendBaseUrl: config.env.frontendBaseUrl,
  })

  // myth-epo4 T22 / MYT-53: per-player character-creation routes
  // (POST /starting-situation, /start-character-creation, /archive,
  // /characters; GET /starting-situations, /characters, /characters/:charId,
  // /hierarchy, /random-tables). Mounted after the campaigns plugin so the
  // routes inherit the same JWT + onboarded + per-campaign-membership gates
  // installed above. characterCreationQueue is forwarded only when present
  // — the boot-gate-disabled fallback path and the unit-test stubs leave it
  // undefined; the start-character-creation route responds 503
  // 'queue_not_ready' in that state (intentional gate per MYT-53 D-?).
  // The `...(cond ? { key: v } : {})` spread is required by
  // exactOptionalPropertyTypes: `characterCreationQueue: undefined` is not
  // assignable to the `characterCreationQueue?: ...` plugin opts.
  await app.register(campaignCharactersPlugin, {
    pool: deps.pg,
    characterCreationQueue: deps.characterCreationQueue,
  })

  await app.register(sessionPrepsPlugin, {
    pool: deps.pg,
    sessionPrepQueue: deps.sessionPrepQueue,
  })

  // MYT-89 audit ③: GET /api/worldgen/stage-timings — global historical
  // avg-per-stage durations for the generation loading-bar ETA. Registered
  // after the access-control + requireOnboarded chain so it inherits the JWT +
  // onboarded gates; it is NOT campaign-scoped (no requireCampaignMember
  // preHandler), so any onboarded caller reads the aggregate telemetry.
  await app.register(worldgenRoutes, { pool: deps.pg })

  // Dev-only routes (MYT-51 T11 credits + MYT-62 T5 prep-prose). The plugins
  // self-gate on AUTH_MODE === 'bypass' (defense in depth — Roc-C1); this
  // outer gate is the belt-and-suspenders second layer. The prep-prose route
  // living in THIS gated block IS the structural enforced-ignorance control:
  // sd_playbook prose (may carry plot secrets) rides the SEPARATE
  // `prep:campaign:{id}` channel, and the only route that serves it exists
  // only under bypass — a production boot never constructs the prose
  // subscriber nor registers the route. The prose subscriber gets its OWN
  // dedicated PSUBSCRIBE client ({ channel: 'prep' }), decorated as
  // mythrunProseSubscriber so the shutdown handler can close it.
  if (config.env.authMode === 'bypass') {
    await app.register(devCreditsRoutes, { pool: deps.pg })
    // MYT-102 — dev-only GET /api/dev/api-cost (the DevCostTicker's endpoint).
    // Previously gated on mythrunEnv !== 'production' ("staging still wants the
    // ticker"), which left it registered on staging (authMode='real') and the
    // widget polling it indefinitely there. The ticker is dev-stack tooling, so
    // it now lives in THIS bypass block like every other /api/dev route: a
    // real-auth boot (staging AND production) never registers it, the request
    // 404s, and the widget hides. The route stays `public` (allowlisted) so it
    // answers on pre-login screens under the bypass identity.
    await app.register(devApiCostRoutes)
    // MYT-66 T10 — dev-only POST /api/dev/campaigns/:campaignId/fire-turn:
    // enqueues one session-turn job so the enqueue → worker → broadcast
    // round-trip can be smoked without the (MYT-67) player-chat trigger path.
    await app.register(devFireTurnRoutes, { queue: deps.sessionTurnQueue, pool: deps.pg })
    const proseSubscriber = createPipelineSubscriber(deps.redisRealtime, deps.redisKeyPrefix, pinoLog, {
      channel: 'prep',
    })
    app.decorate('mythrunProseSubscriber', proseSubscriber)
    await app.register(devPrepProseRoutes, {
      subscriber: proseSubscriber,
      counter,
      frontendBaseUrl: config.env.frontendBaseUrl,
    })
  }

  // Billing plugin (MYT-42 Tasks 25–31). Registered last as a direct
  // child of `app` so it inherits the public-route allowlist + auth
  // hooks installed above. /api/billing/skus is the only public route
  // here; the rest go through the JWT + requireOnboarded chain.
  await app.register(billingRoutes, { pool: deps.pg, env: config.env })

  return app
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'
export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>

/** MYT-51 T12 / myth-epo4 T22: structural contract for a BullMQ Worker as
 *  seen by the shutdown handler. Declared here (rather than importing
 *  BullMQ's `Worker` class type directly) so the ShutdownClients shape
 *  isn't coupled to BullMQ's generic-heavy class type; shutdown tests
 *  inject a hand-rolled spy that satisfies this same shape. Reused for
 *  both the world-gen worker and the character-creation worker — the
 *  drain order is the only thing that's queue-specific. */
export interface BullMqWorkerLike {
  close(): Promise<void>
}

/** MYT-51 T12 / myth-epo4 T22: structural contract for a BullMQ Queue as
 *  seen by the shutdown handler. The queue's request-time surface
 *  (add / getJobCounts / getJob) lives in the route plugins' own
 *  Queue-like interfaces; shutdown only needs `close()`. */
export interface BullMqQueueShutdown {
  close(): Promise<void>
}

export interface ShutdownClients {
  readonly pg: Pool
  readonly redisRealtime: Redis
  readonly redisBatch: Redis
  /** MYT-50: dedicated PSUBSCRIBE client behind the campaigns SSE
   *  stream. Closed BEFORE app.close so attached sinks receive a
   *  structured `server-shutdown` close frame before the HTTP layer
   *  yanks the underlying sockets. */
  readonly subscriber: PipelineSubscriber
  /** MYT-50: clears the connection-counter periodic-log interval. The
   *  interval handle is `unref()`'d so it doesn't pin the event loop,
   *  but we still clear it explicitly so a final 60s log doesn't fire
   *  after the subscriber + app have closed. */
  readonly stopPeriodicLog: () => void
  /** MYT-51 T12: world-gen BullMQ Worker. Closed BEFORE the queue +
   *  app.close so in-flight stage processing can drain (BullMQ's
   *  worker.close() awaits the current job's processor function). */
  readonly worldGenWorker: BullMqWorkerLike
  /** MYT-51 T12: world-gen BullMQ Queue. Closed AFTER its worker has
   *  drained so the worker's emit-completed/emit-failed lifecycle
   *  events still have a live queue to publish on. */
  readonly worldGenQueue: BullMqQueueShutdown
  /** myth-epo4 T22 / MYT-53: character-creation (`campaign-setup`)
   *  BullMQ Worker. Same drain semantics as the world-gen worker — closed
   *  before its queue so an in-flight job can finish its per-stage
   *  processor cleanly. Drained AFTER the world-gen pair because the
   *  two are independent; ordering here is arbitrary, kept stable for the
   *  shutdown trace. */
  readonly characterCreationWorker: BullMqWorkerLike
  /** myth-epo4 T22 / MYT-53: character-creation BullMQ Queue. Closed
   *  AFTER its worker has drained, same rationale as worldGenQueue. */
  readonly characterCreationQueue: BullMqQueueShutdown
}

export const createShutdown = (app: FastifyInstance, clients: ShutdownClients): ShutdownHandler => {
  return async (signal) => {
    try {
      app.log.info({ signal }, 'shutting down')
      // Yield once so pino's async log queue drains before close.
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Drain order matters (MYT-50 spec D14 + MYT-51 T12 extension):
      //   1. Stop the connection-counter interval so a final periodic
      //      log doesn't fire mid-shutdown with already-closed sinks.
      //   2. subscriber.close() PUNSUBSCRIBEs the dedicated client,
      //      walks attached sinks and writes `event: close` frames
      //      with reason: 'server-shutdown', then QUITs that client.
      //      Each sink's onClose decrements the counter — done before
      //      app.close so the SSE response sockets close cleanly
      //      rather than via Fastify's socket-rip at app.close.
      //   3. worldGenWorker.close() drains in-flight stage processing.
      //      BullMQ awaits the current job's processor function before
      //      returning, so this is what gracefully bounds the API-side
      //      worker's exit (separate from the dedicated worker process
      //      in worker.ts which has its own shutdown).
      //   4. worldGenQueue.close() releases the queue's Redis-side
      //      connection bookkeeping. After the worker has drained,
      //      nothing else uses the queue handle.
      //   5. characterCreationWorker.close() — same semantics as
      //      worldGenWorker for the per-player `campaign-setup` queue
      //      added in MYT-53. The two workers run on independent
      //      BullMQ connections; close serially anyway because BullMQ's
      //      `close()` does its own Redis-side cleanup that we want to
      //      observe linearly in shutdown logs.
      //   6. characterCreationQueue.close() — same rationale as
      //      worldGenQueue.close().
      //   7. app.close stops HTTP (no in-flight queries past this).
      //   8. pg.end drains the pool.
      //   9. redis QUIT (realtime + batch) — graceful, flushes
      //      in-flight commands; vs disconnect which rips the socket.
      clients.stopPeriodicLog()
      await clients.subscriber.close()
      // MYT-62 T5: close the dev-only prep-prose subscriber if it exists.
      // It is decorated (not threaded through ShutdownClients) because it is
      // constructed ONLY in the bypass block — absent on a production boot.
      // Closing it here (right after the pipeline subscriber) writes
      // `server-shutdown` close frames to any attached prose sinks + QUITs
      // its dedicated PSUBSCRIBE client before app.close rips the sockets.
      if (app.mythrunProseSubscriber) await app.mythrunProseSubscriber.close()
      // MYT-65 Task 11: close the WS session hub BEFORE app.close. Like the
      // pipeline subscriber, the hub PUNSUBSCRIBEs + QUITs its dedicated
      // PSUBSCRIBE client and clears the registry; doing it before app.close
      // lets connected sockets receive a clean close rather than a socket-rip.
      // Decorated (not threaded through ShutdownClients) and always present
      // after a successful buildApp, so no `if`-guard is needed.
      await app.mythrunSessionHub.close()
      await clients.worldGenWorker.close()
      await clients.worldGenQueue.close()
      await clients.characterCreationWorker.close()
      await clients.characterCreationQueue.close()
      await app.close()
      await clients.pg.end()
      await clients.redisRealtime.quit()
      await clients.redisBatch.quit()
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }
}
// MYT-28 idempotency marker — verifies second push produces new task-def revision
