/**
 * Module augmentation: extends Fastify's `FastifyContextConfig` to admit a
 * typed `auth` discriminator. Routes register via:
 *
 *   app.post('/path', { config: { auth: 'public' } }, handler)
 *   app.post('/path', { config: { auth: 'jwt' } }, handler)  // or omit for default JWT
 *
 * Without this augmentation, `config.auth` is `unknown`, and a typo like
 * `config: { auth: 'pubic' }` would compile silently and (depending on the
 * preHandler implementation) might silently fall through to JWT-required.
 *
 * With this augmentation, the typo is a TS2322 compile error.
 *
 * Per spec §3 lines 113–122. The boot-time PUBLIC_ROUTE_ALLOWLIST hook
 * (Task 11) reads `routeOptions.config?.auth === 'public'` against this
 * narrowed type — no `as` cast needed.
 */
import 'fastify'

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: 'public' | 'jwt'
  }
}
