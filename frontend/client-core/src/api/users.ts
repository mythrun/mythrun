import { useSuspenseQuery } from '@tanstack/react-query'
import {
  MeResponseSchema,
  type MeResponse,
  RegisterRequestSchema,
  RegisterResponseSchema,
  type RegisterRequest,
  type RegisterResponse,
  CheckUsernameResponseSchema,
  type CheckUsernameResponse,
} from '@mythrun/contract/rest'
import { defineEndpoint } from './endpoint.ts'
import { useApiContext } from './client-context.tsx'

// The user-scoped slice of the data layer. `getMe` is the declarative endpoint
// (GET /api/users/me, response validated against the contract's
// `MeResponseSchema`); `useMe` is the thin TanStack-suspense hook the home hub
// renders against. The hook reads the per-call `ApiContext` from
// `useApiContext()` and hands `getMe` to `useSuspenseQuery` — no logic beyond
// that wiring (the validation + transport live in `defineEndpoint`).

export const getMe = defineEndpoint<MeResponse>({
  method: 'GET',
  path: () => '/api/users/me',
  response: MeResponseSchema,
})

export function useMe() {
  const ctx = useApiContext()
  return useSuspenseQuery({
    queryKey: ['me'],
    queryFn: () => getMe(undefined, ctx),
  })
}

/** POST /api/users/register — first-login onboarding. Normal jwt path (Bearer +
 *  401-refresh retry); the auth endpoints are the only `skipAuthRetry` ones. */
export const register = defineEndpoint<RegisterResponse, RegisterRequest>({
  method: 'POST',
  path: () => '/api/users/register',
  request: RegisterRequestSchema,
  response: RegisterResponseSchema,
})

/** GET /api/users/check-username — advisory availability probe. */
export const checkUsername = defineEndpoint<CheckUsernameResponse, string>({
  method: 'GET',
  path: (username) => `/api/users/check-username?username=${encodeURIComponent(username)}`,
  response: CheckUsernameResponseSchema,
})
