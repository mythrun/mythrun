import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createInvite,
  listInvites,
  revokeInvite,
  previewInvite,
  acceptInvite,
  ensurePrimaryInvite,
} from '../invites.ts'
import type { ApiContext } from '../endpoint.ts'
import { HttpError, isHttpError } from '../errors.ts'

// The invite slices (MYT-91 Task 2) wrap the shipped MYT-75 invite routes as
// declarative `defineEndpoint`s. These drive each slice's method/path/body/parse
// against a stubbed global `fetch` (the transport `defineEndpoint.send` calls),
// plus `ensurePrimaryInvite` — now a SINGLE idempotent PUT to the server-side
// get-or-create (myth-y5c4q), no longer the old list-then-create RMW that
// double-minted under a StrictMode/two-tab race. The preview slice is PUBLIC
// (`skipAuthRetry`), asserted by the endpoint-layer tests; here we assert its
// path + parse.

function responseOf(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Stubs global `fetch` to resolve a single response; returns the matching ctx. */
function ctxReturning(status: number, body: unknown): ApiContext {
  const fetchMock = vi.fn().mockResolvedValue(responseOf(status, body))
  vi.stubGlobal('fetch', fetchMock)
  return { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('invite slices', () => {
  it('createInvite POSTs the campaign invites path and parses the invite', async () => {
    const ctx = ctxReturning(201, {
      inviteCode: 'ABC',
      inviteUrl: 'http://app/join/ABC',
      uses: 0,
      expiresAt: null,
      createdAt: '2026-07-14T00:00:00.000Z',
    })
    const invite = await createInvite(ctx, 'camp-1')
    expect(invite.inviteCode).toBe('ABC')
    // The route takes NO body — a stray empty JSON body + content-type 400s it
    // (T1 probe). The slice declares no `request` schema, so the init carries
    // only method + the (empty) auth headers: no `body`, no `Content-Type`.
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/campaigns/camp-1/invites', {
      method: 'POST',
      headers: {},
    })
  })

  it('listInvites GETs the campaign invites path and parses the list (with the primary flag)', async () => {
    const ctx = ctxReturning(200, {
      invites: [
        { inviteCode: 'P', inviteUrl: 'u', uses: 2, expiresAt: null, createdAt: 'x', primary: true },
      ],
    })
    const { invites } = await listInvites(ctx, 'camp-1')
    expect(invites[0]?.primary).toBe(true)
    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/campaigns/camp-1/invites',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('revokeInvite DELETEs the invite path and resolves void on 204', async () => {
    const ctx = ctxReturning(204, null)
    await expect(revokeInvite(ctx, 'camp-1', 'ABC')).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/campaigns/camp-1/invites/ABC',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('previewInvite GETs the PUBLIC preview path (no retry) and parses validity', async () => {
    const ctx = ctxReturning(200, {
      campaignName: 'Ashfall',
      ownerUsername: 'mara',
      ownerDisplayName: 'Mara',
      valid: true,
    })
    const preview = await previewInvite(ctx, 'ABC')
    expect(preview.valid).toBe(true)
    expect(preview.ownerDisplayName).toBe('Mara')
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/invites/ABC/preview', expect.anything())
  })

  it('acceptInvite parses {campaignId, alreadyMember} on 201 and sends NO body', async () => {
    const ctx = ctxReturning(201, { campaignId: 'camp-1', alreadyMember: false })
    expect(await acceptInvite(ctx, 'ABC')).toEqual({ campaignId: 'camp-1', alreadyMember: false })
    // Accept, like create, takes no request body (the code rides the path).
    expect(fetch).toHaveBeenCalledWith('http://api.test/api/invites/ABC/accept', {
      method: 'POST',
      headers: {},
    })
  })

  it('previewInvite RESOLVES a revoked/expired code (200 valid:false) — it does NOT throw', async () => {
    // T1 probe: an expired/revoked code is a 200 with valid:false, NOT a 404.
    // The slice must resolve it so the consumer can render the invalid arm off
    // `valid`, distinct from the unknown-code 404 that throws below.
    const ctx = ctxReturning(200, {
      campaignName: 'Ashfall',
      ownerUsername: 'mara',
      ownerDisplayName: 'Mara',
      valid: false,
    })
    const preview = await previewInvite(ctx, 'GONE')
    expect(preview.valid).toBe(false)
  })

  it('previewInvite THROWS a typed HttpError invite_not_found for an unknown code (404)', async () => {
    const ctx = ctxReturning(404, { code: 'invite_not_found' })
    const error = await previewInvite(ctx, 'NOPE').catch((e: unknown) => e)
    expect(isHttpError(error)).toBe(true)
    expect((error as HttpError).status).toBe(404)
    expect((error as HttpError).code).toBe('invite_not_found')
  })

  it('ensurePrimaryInvite is a SINGLE idempotent PUT to .../invites/primary (no list-then-create)', async () => {
    // The race fix (myth-y5c4q): the client no longer lists-then-creates (two
    // calls, both racing to POST). One PUT to the atomic server-side
    // get-or-create — repeated calls return the SAME primary, so a StrictMode
    // double-mount / two tabs can't double-mint. The response carries primary:true.
    const ctx = ctxReturning(200, {
      inviteCode: 'P',
      inviteUrl: 'http://app/join/P',
      uses: 1,
      expiresAt: null,
      createdAt: '2026-07-14T00:00:00.000Z',
      primary: true,
    })
    const invite = await ensurePrimaryInvite(ctx, 'camp-1')
    expect(invite.inviteCode).toBe('P')
    expect(invite.primary).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1) // ONE call — no list, no separate create
    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/campaigns/camp-1/invites/primary',
      expect.objectContaining({ method: 'PUT' }),
    )
  })
})
