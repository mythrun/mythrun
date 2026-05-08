// backend/src/auth/require-db-user.ts
//
// Helper that narrows request.dbUser from optional to required. Throws
// if called from a route where requireOnboarded didn't run upstream
// (which would indicate a misconfigured route — public/jwt-no-db routes
// don't have dbUser attached).
//
// Parallels require-user.ts; lives in its own file (not types.ts) so
// type augmentation and runtime helpers don't share a module.

import type { User } from '../repo/types.js'

export function requireDbUser(request: { dbUser?: User | undefined }): User {
  if (!request.dbUser) {
    throw new Error(
      'requireDbUser: request.dbUser is undefined — was requireOnboarded registered before this hook?',
    )
  }
  return request.dbUser
}
