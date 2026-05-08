// backend/src/auth/require-user.ts
//
// Helper for protected handlers — narrows request.user from optional to
// required. Throws if called from a public-route handler (which would
// indicate the route was misconfigured `config.auth = 'public'` and then
// tried to use the user). Lives in its own file (not types.ts) so type
// augmentation and runtime helpers don't share a module.

import type { AuthUser } from './types.js'

export function requireUser(request: { user?: AuthUser | undefined }): AuthUser {
  if (!request.user) {
    throw new Error('requireUser: request.user is undefined — was this route marked public?')
  }
  return request.user
}
