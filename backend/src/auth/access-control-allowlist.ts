// backend/src/auth/access-control-allowlist.ts
//
// Boot-time gate. onRoute collects every route whose preHandler array
// contains a function named `requireCampaignMember` or
// `requireWorldCreator`; onReady asserts none of those routes have
// config.auth set to 'public' or 'jwt-no-db'. Catches the misconfig
// where a contributor wires access-control onto a route that
// short-circuits requireOnboarded — without this gate, the route would
// 500 only when traffic arrives.
//
// Mirrors the JWT_NO_DB_ALLOWLIST pattern in require-onboarded.ts.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-39-access-control-ws-ticket-design.md §4

import fp from 'fastify-plugin'
import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import { ACCESS_CONTROL_MARKER, type AccessControlKind } from './access-control.js'

// eslint-disable-next-line @typescript-eslint/require-await
const impl: FastifyPluginAsync = async (app) => {
  const offenders: { method: string; url: string; kind: AccessControlKind }[] = []

  app.addHook('onRoute', (routeOptions) => {
    const handlers = routeOptions.preHandler as
      | preHandlerHookHandler
      | preHandlerHookHandler[]
      | undefined
    const arr = Array.isArray(handlers) ? handlers : handlers ? [handlers] : []
    const guardedBy = arr
      .map((h) => (h as { [ACCESS_CONTROL_MARKER]?: AccessControlKind })[ACCESS_CONTROL_MARKER])
      .find((kind): kind is AccessControlKind => kind !== undefined)
    if (!guardedBy) return
    const cfg = routeOptions.config as { auth?: string } | undefined
    if (cfg?.auth === 'public' || cfg?.auth === 'jwt-no-db') {
      /* c8 ignore start — defense-in-depth: Fastify allows `method` as
       * a string or string[], but no in-tree route registers an
       * access-control-guarded handler with array methods. */
      const methods = Array.isArray(routeOptions.method)
        ? routeOptions.method
        : [routeOptions.method]
      /* c8 ignore stop */
      for (const m of methods) {
        if (m.toUpperCase() === 'HEAD') continue
        offenders.push({ method: m, url: routeOptions.url, kind: guardedBy })
      }
    }
  })

  // eslint-disable-next-line @typescript-eslint/require-await
  app.addHook('onReady', async () => {
    if (offenders.length > 0) {
      const list = offenders.map((o) => `${o.method} ${o.url} (${o.kind})`).join(', ')
      throw new Error(
        `access-control-allowlist: route(s) with requireCampaignMember/requireWorldCreator must NOT ` +
          `set config.auth to 'public' or 'jwt-no-db' — that short-circuits requireOnboarded and ` +
          `leaves request.dbUser undefined. Offenders: ${list}`,
      )
    }
  })
}

export const accessControlAllowlist = fp(impl, {
  fastify: '5.x',
  name: 'mythrun-access-control-allowlist',
})
