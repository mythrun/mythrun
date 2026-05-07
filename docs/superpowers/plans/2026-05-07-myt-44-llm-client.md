# MYT-44 LLM Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the LLM wrapper layer per `docs/superpowers/specs/2026-05-07-myt-44-llm-client-design.md`. After this issue, `classifyProfanity` calls real Haiku via `generateObject` for both offensive content and impersonation classification, and every Mythrun LLM call goes through a logging-and-error-normalization middleware.

**Architecture:** Vercel AI SDK v6 (`ai` + `@ai-sdk/anthropic`) provides the provider abstraction; Mythrun-owned code is limited to model-constant definitions wrapped with a logging middleware, an error taxonomy mapped from Vercel's classes, a `.txt` prompt-template loader, a Zod schema for the profanity result, and the rewired profanity classifier. Tests `vi.mock('ai')` at the SDK boundary; one staging smoke confirms a real Haiku call works end-to-end.

**Tech Stack:** TypeScript strict, Vitest, pino (existing), Zod (existing), `ai@^6` (new), `@ai-sdk/anthropic@latest` (new)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `backend/src/config/env.ts` | Modify | Add `anthropicApiKey: string` to `Env`; add `validateAnthropicApiKey` (sk-ant- prefix); thread into `loadEnv` |
| `backend/src/config/__tests__/env.test.ts` | Modify | Add ANTHROPIC_API_KEY required-field cases to existing tests |
| `backend/.env.development.example` | Modify | Add placeholder `ANTHROPIC_API_KEY=sk-ant-REPLACE_ME_dev_only` |
| `backend/.env.development` | Modify | Add placeholder so local boot doesn't fail |
| `backend/package.json` | Modify | Add `ai`, `@ai-sdk/anthropic` deps |
| `backend/src/llm/logger.ts` | Create | Module-level pino instance for the LLM layer (test-mockable) |
| `backend/src/llm/errors.ts` | Create | 7 typed error classes + `mapToMythrunError` |
| `backend/src/llm/__tests__/errors.test.ts` | Create | Mapper coverage for each Vercel error class |
| `backend/src/llm/middleware.ts` | Create | `logAndNormalizeMiddleware(modelId)` factory |
| `backend/src/llm/__tests__/middleware.test.ts` | Create | Logging fires; errors map; sessionId/userId threading |
| `backend/src/llm/models.ts` | Create | `HAIKU` / `SONNET` / `OPUS` wrapped model constants |
| `backend/src/llm/prompts.ts` | Create | `loadPrompt(area, name, vars?)` with cache + interpolation |
| `backend/src/llm/__tests__/prompts.test.ts` | Create | Read, cache, interpolate, missing-file throw |
| `backend/src/llm/prompts/auth/profanity.txt` | Create | System prompt verbatim from spec §4.6 |
| `backend/src/llm/schemas/profanity.ts` | Create | `ProfanitySchema` (Zod) + `ProfanityResult` type |
| `backend/src/llm/profanity.ts` | Modify | Replace stub body with `generateObject` Haiku call; drop `RESERVED_USERNAMES` |
| `backend/src/llm/__tests__/profanity.test.ts` | Modify | Replace static-list tests with `vi.mock('ai')` SDK-mocked tests |
| `backend/src/llm/profanity-seed-en.txt` | Delete | Seed list no longer used |
| `backend/src/routes/users.ts` | Modify | Update `result.reason ?? 'profane'` fallbacks to `'offensive'` |
| `infra/modules/serving/main.tf` | Modify | Add `ANTHROPIC_API_KEY` to ECS task definition `secrets` block |

---

## Task 1: Add `ANTHROPIC_API_KEY` to Env

**Files:**
- Modify: `backend/src/config/env.ts`
- Modify: `backend/src/config/__tests__/env.test.ts`

- [ ] **Step 1: Read current env.ts to understand the validateStripeSecretKey pattern**

Run: `grep -n "validateStripeSecretKey\|STRIPE_SECRET_KEY" backend/src/config/env.ts`

Expected: see how `validateStripeSecretKey` is structured and called from `loadEnv`. Mirror it for Anthropic.

- [ ] **Step 2: Add a failing test for missing ANTHROPIC_API_KEY**

Edit `backend/src/config/__tests__/env.test.ts`. Find the existing `STRIPE_SECRET_KEY required` test and add a sibling test:

```ts
it('throws when ANTHROPIC_API_KEY is missing', () => {
  Object.assign(process.env, URL_FORM, {
    AUTH_MODE: 'real',
    NODE_ENV: 'production',
    COGNITO_USER_POOL_ID: 'us-east-1_test',
    COGNITO_APP_CLIENT_ID: 'abc123',
    COGNITO_ISSUER_URL: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    FRONTEND_BASE_URL: 'https://staging.mythrun.com',
    STRIPE_SECRET_KEY: 'rk_test_abc',
    STRIPE_WEBHOOK_SECRET: 'whsec_abc',
  })
  expect(() => loadEnv()).toThrow('ANTHROPIC_API_KEY is required')
})

it('throws when ANTHROPIC_API_KEY does not have sk-ant- prefix', () => {
  Object.assign(process.env, URL_FORM, {
    AUTH_MODE: 'real',
    NODE_ENV: 'production',
    COGNITO_USER_POOL_ID: 'us-east-1_test',
    COGNITO_APP_CLIENT_ID: 'abc123',
    COGNITO_ISSUER_URL: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    FRONTEND_BASE_URL: 'https://staging.mythrun.com',
    STRIPE_SECRET_KEY: 'rk_test_abc',
    STRIPE_WEBHOOK_SECRET: 'whsec_abc',
    ANTHROPIC_API_KEY: 'wrong-prefix-abc',
  })
  expect(() => loadEnv()).toThrow(/ANTHROPIC_API_KEY must have sk-ant- prefix/)
})
```

Update the existing happy-path tests to also set `ANTHROPIC_API_KEY: 'sk-ant-test-key'` so they don't break on the new required field.

- [ ] **Step 3: Run tests; confirm the new failing tests fail**

Run: `pnpm --filter @mythrun/backend test src/config/__tests__/env.test.ts`

Expected: the two new tests fail (one of: "Cannot read property" / "no key validation" / similar). The existing tests may pass or may now fail because they don't yet provide ANTHROPIC_API_KEY — that's expected after step 2's update.

- [ ] **Step 4: Implement `validateAnthropicApiKey` and wire it in**

Edit `backend/src/config/env.ts`. Add to the `Env` interface after `stripeWebhookSecret`:

```ts
readonly anthropicApiKey: string
```

Add a validator after `validateStripeSecretKey`:

```ts
function validateAnthropicApiKey(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) {
    throw new Error('ANTHROPIC_API_KEY is required')
  }
  if (!raw.startsWith('sk-ant-')) {
    throw new Error(
      `ANTHROPIC_API_KEY must have sk-ant- prefix; got prefix '${raw.slice(0, 7)}'. ` +
      `Pull a key from Anthropic Console (test keys are fine for non-prod).`,
    )
  }
  return raw
}
```

In `loadEnv`, after the `stripeWebhookSecret` line, add:

```ts
const anthropicApiKey = validateAnthropicApiKey(process.env.ANTHROPIC_API_KEY)
```

And include `anthropicApiKey` in the returned `Env` object.

- [ ] **Step 5: Run tests; confirm all pass**

Run: `pnpm --filter @mythrun/backend test src/config/__tests__/env.test.ts`

Expected: all tests pass including the two new ones.

- [ ] **Step 6: Update `.env.development.example` and `.env.development`**

Edit `backend/.env.development.example`. Add at the bottom:

```
# ANTHROPIC_API_KEY pulls from Anthropic Console
# (https://console.anthropic.com/settings/keys). Test keys are fine for
# local dev. Required at boot.
ANTHROPIC_API_KEY=sk-ant-REPLACE_ME_dev_only
```

Edit `backend/.env.development` to match (real keys go via your shell or 1Password injection per project convention; the placeholder in the example file mirrors the format).

- [ ] **Step 7: Commit**

```bash
git add backend/src/config/env.ts backend/src/config/__tests__/env.test.ts backend/.env.development.example backend/.env.development
git commit -m "feat(env): add ANTHROPIC_API_KEY required field"
```

---

## Task 2: Install Vercel AI SDK packages

**Files:**
- Modify: `backend/package.json` + lockfile

- [ ] **Step 1: Add the packages**

Run: `pnpm --filter @mythrun/backend add ai @ai-sdk/anthropic`

Expected: `pnpm-lock.yaml` updates; both packages added to `backend/package.json` dependencies.

- [ ] **Step 2: Verify the install + check versions**

Run: `pnpm --filter @mythrun/backend list ai @ai-sdk/anthropic`

Expected: `ai` is on a 6.x version; `@ai-sdk/anthropic` is on its latest. Note both versions in the commit message for traceability.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json pnpm-lock.yaml
git commit -m "feat(myt-44): add ai + @ai-sdk/anthropic deps"
```

---

## Task 3: Module-level logger for the LLM layer

**Files:**
- Create: `backend/src/llm/logger.ts`

The middleware needs a logger that's usable outside Fastify request scope. A small module-level pino instance — vi.spyOn-able in tests.

- [ ] **Step 1: Create the logger**

```ts
// backend/src/llm/logger.ts
import pino from 'pino'

/**
 * Module-level pino instance for the LLM layer. Used by the middleware to
 * emit structured `event: 'llm.call'` and `event: 'llm.error'` log lines on
 * every wrapped model call.
 *
 * Tests mock the SDK at the import boundary (`vi.mock('ai')`); they do not
 * need to mock this logger. If a test needs to assert log shape, it can
 * `vi.spyOn(logger, 'info')` / `vi.spyOn(logger, 'error')`.
 */
export const logger = pino({
  base: { component: 'llm' },
  level: process.env.LOG_LEVEL ?? 'info',
})
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/llm/logger.ts
git commit -m "feat(myt-44): module-level pino logger for the llm layer"
```

---

## Task 4: Error taxonomy + mapper

**Files:**
- Create: `backend/src/llm/errors.ts`
- Create: `backend/src/llm/__tests__/errors.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/llm/__tests__/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
import {
  LlmRateLimitedError,
  LlmOverloadedError,
  LlmAuthError,
  LlmInvalidRequestError,
  LlmContextTooLongError,
  LlmTimeoutError,
  LlmStructuredOutputError,
  mapToMythrunError,
} from '../errors.js'

describe('mapToMythrunError', () => {
  it('maps 429 APICallError to LlmRateLimitedError', () => {
    const upstream = new APICallError({
      message: 'rate limited', url: 'https://api.anthropic.com', statusCode: 429,
      requestBodyValues: {}, isRetryable: true,
    })
    const mapped = mapToMythrunError(upstream)
    expect(mapped).toBeInstanceOf(LlmRateLimitedError)
    expect(mapped.cause).toBe(upstream)
  })

  it('maps 529 APICallError to LlmOverloadedError', () => {
    const upstream = new APICallError({
      message: 'overloaded', url: 'https://api.anthropic.com', statusCode: 529,
      requestBodyValues: {}, isRetryable: true,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmOverloadedError)
  })

  it('maps 401 APICallError to LlmAuthError', () => {
    const upstream = new APICallError({
      message: 'invalid key', url: 'https://api.anthropic.com', statusCode: 401,
      requestBodyValues: {}, isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmAuthError)
  })

  it('maps 400 with context-window message to LlmContextTooLongError', () => {
    const upstream = new APICallError({
      message: 'prompt is too long: context window exceeded',
      url: 'https://api.anthropic.com', statusCode: 400,
      requestBodyValues: {}, isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmContextTooLongError)
  })

  it('maps generic 400 APICallError to LlmInvalidRequestError', () => {
    const upstream = new APICallError({
      message: 'invalid params', url: 'https://api.anthropic.com', statusCode: 400,
      requestBodyValues: {}, isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmInvalidRequestError)
  })

  it('maps DOMException AbortError to LlmTimeoutError', () => {
    const upstream = new DOMException('aborted', 'AbortError')
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmTimeoutError)
  })

  it('passes unknown errors through unchanged', () => {
    const upstream = new Error('something else')
    expect(mapToMythrunError(upstream)).toBe(upstream)
  })

  it('preserves cause chain on every mapped error', () => {
    const upstream = new APICallError({
      message: 'x', url: 'https://api.anthropic.com', statusCode: 401,
      requestBodyValues: {}, isRetryable: false,
    })
    const mapped = mapToMythrunError(upstream) as Error
    expect(mapped.cause).toBe(upstream)
  })
})
```

(Note: `LlmStructuredOutputError` mapping happens in `generateObject`-specific path which throws `AI_NoObjectGeneratedError` from the `ai` package, not `@ai-sdk/provider`. Add a test for it once the implementation exists if `ai` exports the class; otherwise rely on instanceof check via a name match. Cover via the middleware test suite if the import is awkward.)

- [ ] **Step 2: Run; verify failure**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/errors.test.ts`

Expected: FAIL — module `../errors.js` does not exist.

- [ ] **Step 3: Implement `errors.ts`**

```ts
// backend/src/llm/errors.ts
import { APICallError } from '@ai-sdk/provider'

export class LlmRateLimitedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmRateLimitedError'
  }
}
export class LlmOverloadedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmOverloadedError'
  }
}
export class LlmAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmAuthError'
  }
}
export class LlmInvalidRequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmInvalidRequestError'
  }
}
export class LlmContextTooLongError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmContextTooLongError'
  }
}
export class LlmTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmTimeoutError'
  }
}
export class LlmStructuredOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LlmStructuredOutputError'
  }
}

const CONTEXT_WINDOW_RE = /context window|too long|maximum context/i

export function mapToMythrunError(err: unknown): Error {
  // AbortError → timeout
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new LlmTimeoutError('llm call aborted', { cause: err })
  }
  // AI SDK structured-output error (matched by name; class lives in `ai`
  // package and isn't always re-exported under a stable path).
  if (err instanceof Error && err.name === 'AI_NoObjectGeneratedError') {
    return new LlmStructuredOutputError(
      'llm returned unparseable structured output',
      { cause: err },
    )
  }
  // Vercel SDK API call errors
  if (err instanceof APICallError) {
    const status = err.statusCode
    if (status === 429) {
      return new LlmRateLimitedError(`upstream rate limited: ${err.message}`, { cause: err })
    }
    if (status === 529) {
      return new LlmOverloadedError(`upstream overloaded: ${err.message}`, { cause: err })
    }
    if (status === 401 || status === 403) {
      return new LlmAuthError(`upstream auth failed: ${err.message}`, { cause: err })
    }
    if (status === 400 && CONTEXT_WINDOW_RE.test(err.message)) {
      return new LlmContextTooLongError(`context too long: ${err.message}`, { cause: err })
    }
    if (status !== undefined && status >= 400 && status < 500) {
      return new LlmInvalidRequestError(`upstream rejected request: ${err.message}`, { cause: err })
    }
  }
  // Fall through — unknown error, pass through unchanged.
  return err instanceof Error ? err : new Error(String(err))
}
```

- [ ] **Step 4: Run tests; confirm all pass**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/errors.test.ts`

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/errors.ts backend/src/llm/__tests__/errors.test.ts
git commit -m "feat(myt-44): error taxonomy + mapToMythrunError"
```

---

## Task 5: Logging + error-normalization middleware

**Files:**
- Create: `backend/src/llm/middleware.ts`
- Create: `backend/src/llm/__tests__/middleware.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/llm/__tests__/middleware.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
import { logAndNormalizeMiddleware } from '../middleware.js'
import { logger } from '../logger.js'
import { LlmRateLimitedError } from '../errors.js'

describe('logAndNormalizeMiddleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('logs llm.call with model, tokens, latency on success', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-4-5-test')
    const fakeResult = {
      content: [{ type: 'text', text: 'hi' }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 47, outputTokens: 8, totalTokens: 55 },
    }
    const out = await mw.wrapGenerate!({
      doGenerate: async () => fakeResult as never,
      params: {} as never,
      model: {} as never,
    })
    expect(out).toBe(fakeResult)
    expect(infoSpy).toHaveBeenCalledOnce()
    const [obj, msg] = infoSpy.mock.calls[0]!
    expect(obj).toMatchObject({
      event: 'llm.call',
      model: 'claude-haiku-4-5-test',
      inputTokens: 47,
      outputTokens: 8,
      totalTokens: 55,
      finishReason: 'stop',
    })
    expect(typeof (obj as { latencyMs: number }).latencyMs).toBe('number')
    expect(msg).toBe('llm call completed')
  })

  it('logs llm.error and rethrows mapped error on APICallError', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-4-5-test')
    const upstream = new APICallError({
      message: 'rate limited', url: 'https://api.anthropic.com', statusCode: 429,
      requestBodyValues: {}, isRetryable: true,
    })
    await expect(
      mw.wrapGenerate!({
        doGenerate: async () => { throw upstream },
        params: {} as never,
        model: {} as never,
      }),
    ).rejects.toBeInstanceOf(LlmRateLimitedError)
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('extracts sessionId/userId from providerOptions.mythrun', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const mw = logAndNormalizeMiddleware('claude-haiku-4-5-test')
    const params = {
      providerOptions: { mythrun: { sessionId: 'sess-1', userId: 'user-9' } },
    } as never
    await mw.wrapGenerate!({
      doGenerate: async () => ({
        content: [], finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as never),
      params,
      model: {} as never,
    })
    const [obj] = infoSpy.mock.calls[0]!
    expect(obj).toMatchObject({ sessionId: 'sess-1', userId: 'user-9' })
  })
})
```

- [ ] **Step 2: Run; verify failure**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/middleware.test.ts`

Expected: FAIL — `../middleware.js` does not exist.

- [ ] **Step 3: Implement `middleware.ts`**

```ts
// backend/src/llm/middleware.ts
import type { LanguageModelV4Middleware } from '@ai-sdk/provider'
import { logger } from './logger.js'
import { mapToMythrunError } from './errors.js'

interface MythrunContext {
  readonly sessionId?: string
  readonly userId?: string
}

function extractMythrunContext(params: unknown): MythrunContext {
  if (typeof params !== 'object' || params === null) return {}
  const providerOptions = (params as { providerOptions?: unknown }).providerOptions
  if (typeof providerOptions !== 'object' || providerOptions === null) return {}
  const mythrun = (providerOptions as { mythrun?: unknown }).mythrun
  if (typeof mythrun !== 'object' || mythrun === null) return {}
  const ctx = mythrun as MythrunContext
  return {
    sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined,
    userId: typeof ctx.userId === 'string' ? ctx.userId : undefined,
  }
}

export function logAndNormalizeMiddleware(modelId: string): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate, params }) => {
      const start = Date.now()
      const ctx = extractMythrunContext(params)
      try {
        const result = await doGenerate()
        logger.info(
          {
            event: 'llm.call',
            model: modelId,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            latencyMs: Date.now() - start,
            finishReason: result.finishReason,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
          },
          'llm call completed',
        )
        return result
      } catch (err) {
        logger.error(
          {
            event: 'llm.error',
            model: modelId,
            err,
            latencyMs: Date.now() - start,
            sessionId: ctx.sessionId,
            userId: ctx.userId,
          },
          'llm call failed',
        )
        throw mapToMythrunError(err)
      }
    },
  }
}
```

- [ ] **Step 4: Run tests; confirm all pass**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/middleware.test.ts`

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/middleware.ts backend/src/llm/__tests__/middleware.test.ts
git commit -m "feat(myt-44): logging + error-normalization middleware"
```

---

## Task 6: Model constants

**Files:**
- Create: `backend/src/llm/models.ts`

This task has no unit test of its own — the model objects are exercised by the profanity test in Task 9 (which uses `HAIKU` as the model parameter to a mocked `generateObject`).

- [ ] **Step 1: Implement `models.ts`**

```ts
// backend/src/llm/models.ts
import { wrapLanguageModel } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { logAndNormalizeMiddleware } from './middleware.js'

// Model IDs match CLAUDE.md's pinned versions. Bumping a version is a
// deliberate spec patch — Anthropic occasionally ships breaking changes
// across model lines.
const HAIKU_ID = 'claude-haiku-4-5-20251001'
const SONNET_ID = 'claude-sonnet-4-6'
const OPUS_ID = 'claude-opus-4-7'

export const HAIKU = wrapLanguageModel({
  model: anthropic(HAIKU_ID),
  middleware: logAndNormalizeMiddleware(HAIKU_ID),
})

export const SONNET = wrapLanguageModel({
  model: anthropic(SONNET_ID),
  middleware: logAndNormalizeMiddleware(SONNET_ID),
})

export const OPUS = wrapLanguageModel({
  model: anthropic(OPUS_ID),
  middleware: logAndNormalizeMiddleware(OPUS_ID),
})
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter @mythrun/backend typecheck`

Expected: 0 errors. If TypeScript complains about `LanguageModelV4Middleware` type mismatch, check the `ai` package version — middleware spec may have updated.

- [ ] **Step 3: Commit**

```bash
git add backend/src/llm/models.ts
git commit -m "feat(myt-44): HAIKU/SONNET/OPUS model constants with middleware"
```

---

## Task 7: Prompt template loader

**Files:**
- Create: `backend/src/llm/prompts.ts`
- Create: `backend/src/llm/__tests__/prompts.test.ts`
- Create: `backend/src/llm/prompts/auth/profanity.txt` (Task 8)

- [ ] **Step 1: Write the failing tests**

Create `backend/src/llm/__tests__/prompts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { loadPrompt, _resetPromptCacheForTests } from '../prompts.js'

const here = dirname(fileURLToPath(import.meta.url))
const promptsDir = resolve(here, '..', 'prompts')

describe('loadPrompt', () => {
  beforeEach(() => {
    _resetPromptCacheForTests()
    // Ensure the auth area exists for these tests
    mkdirSync(resolve(promptsDir, 'auth'), { recursive: true })
  })

  it('reads a template file and returns it', () => {
    const path = resolve(promptsDir, 'auth', 'test_simple.txt')
    writeFileSync(path, 'hello world')
    try {
      expect(loadPrompt('auth', 'test_simple')).toBe('hello world')
    } finally {
      rmSync(path)
    }
  })

  it('interpolates {{variable}} placeholders', () => {
    const path = resolve(promptsDir, 'auth', 'test_interp.txt')
    writeFileSync(path, 'Hello {{name}}, welcome to {{app}}!')
    try {
      expect(
        loadPrompt('auth', 'test_interp', { name: 'Miklos', app: 'Mythrun' }),
      ).toBe('Hello Miklos, welcome to Mythrun!')
    } finally {
      rmSync(path)
    }
  })

  it('caches the template — second call does not re-read', () => {
    const path = resolve(promptsDir, 'auth', 'test_cache.txt')
    writeFileSync(path, 'first read')
    try {
      const first = loadPrompt('auth', 'test_cache')
      writeFileSync(path, 'second read')  // mutate file after first read
      const second = loadPrompt('auth', 'test_cache')
      expect(first).toBe(second)
      expect(second).toBe('first read')  // cache returns the original
    } finally {
      rmSync(path)
    }
  })

  it('throws on missing file', () => {
    expect(() => loadPrompt('auth', 'does_not_exist')).toThrow()
  })

  it('handles undefined vars (no interpolation)', () => {
    const path = resolve(promptsDir, 'auth', 'test_noargs.txt')
    writeFileSync(path, 'no placeholders here')
    try {
      expect(loadPrompt('auth', 'test_noargs')).toBe('no placeholders here')
    } finally {
      rmSync(path)
    }
  })

  it('leaves unmatched {{placeholders}} alone if vars do not include them', () => {
    const path = resolve(promptsDir, 'auth', 'test_unmatched.txt')
    writeFileSync(path, 'Has {{a}} and {{b}}')
    try {
      expect(loadPrompt('auth', 'test_unmatched', { a: 'X' })).toBe(
        'Has X and {{b}}',
      )
    } finally {
      rmSync(path)
    }
  })
})
```

- [ ] **Step 2: Run; verify failure**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/prompts.test.ts`

Expected: FAIL — `../prompts.js` does not exist.

- [ ] **Step 3: Implement `prompts.ts`**

```ts
// backend/src/llm/prompts.ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PROMPTS_ROOT = resolve(here, 'prompts')

const cache = new Map<string, string>()

/**
 * Replace `{{var}}` occurrences in `template` with values from `vars`.
 * Unmatched placeholders are left as-is so a missing variable surfaces
 * visibly in the rendered output (and on inspection of the LLM call).
 */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  })
}

/**
 * Load a prompt template from `backend/src/llm/prompts/<area>/<name>.txt`,
 * cache it on first read, and interpolate `{{vars}}` if provided. Throws
 * on missing files (boot-time discovery is the design — this is called
 * during normal request handling).
 */
export function loadPrompt(
  area: string,
  name: string,
  vars?: Record<string, string>,
): string {
  const key = `${area}/${name}`
  let template = cache.get(key)
  if (template === undefined) {
    const path = resolve(PROMPTS_ROOT, area, `${name}.txt`)
    template = readFileSync(path, 'utf-8')
    cache.set(key, template)
  }
  return interpolate(template, vars ?? {})
}

export function _resetPromptCacheForTests(): void {
  cache.clear()
}
```

- [ ] **Step 4: Run tests; confirm all pass**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/prompts.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prompts.ts backend/src/llm/__tests__/prompts.test.ts
git commit -m "feat(myt-44): file-based prompt template loader"
```

---

## Task 8: Profanity prompt template + Zod schema

**Files:**
- Create: `backend/src/llm/prompts/auth/profanity.txt`
- Create: `backend/src/llm/schemas/profanity.ts`

- [ ] **Step 1: Create the prompt template**

Create `backend/src/llm/prompts/auth/profanity.txt` with this content verbatim:

```
You classify usernames for an online D&D platform. Reject the username if:

1. It contains offensive content: profanity, slurs, sexual content, hate
   speech, or explicit references to violence. Set reason='offensive'.

2. It impersonates: a system role (admin, support, moderator, root), the
   Mythrun brand or staff, or a technical identifier (noreply, null,
   undefined, system). Set reason='impersonation'.

Otherwise set profane=false. If both apply, prefer 'offensive'.
```

- [ ] **Step 2: Create the schema file**

```ts
// backend/src/llm/schemas/profanity.ts
import { z } from 'zod'

/**
 * Result of classifying a username for offensive content or impersonation.
 *
 * `reason` is omitted when `profane` is false. When `profane` is true, the
 * model returns one of two categories:
 *   - 'offensive': profanity, slurs, sexual content, hate speech, violence
 *   - 'impersonation': system role, Mythrun brand/staff, technical identifier
 *
 * If both categories apply, the prompt instructs the model to prefer
 * 'offensive' (it's the stronger reason for rejection).
 */
export const ProfanitySchema = z.object({
  profane: z.boolean(),
  reason: z.enum(['offensive', 'impersonation']).optional(),
})

export type ProfanityResult = z.infer<typeof ProfanitySchema>
```

- [ ] **Step 3: Sanity-check the schema with a quick inline test**

Add to `backend/src/llm/__tests__/profanity.test.ts` (this test will be expanded in Task 9):

```ts
import { describe, it, expect } from 'vitest'
import { ProfanitySchema } from '../schemas/profanity.js'

describe('ProfanitySchema', () => {
  it('parses {profane: false}', () => {
    expect(ProfanitySchema.parse({ profane: false })).toEqual({ profane: false })
  })
  it('parses {profane: true, reason: "offensive"}', () => {
    expect(ProfanitySchema.parse({ profane: true, reason: 'offensive' })).toEqual({
      profane: true, reason: 'offensive',
    })
  })
  it('parses {profane: true, reason: "impersonation"}', () => {
    expect(ProfanitySchema.parse({ profane: true, reason: 'impersonation' })).toEqual({
      profane: true, reason: 'impersonation',
    })
  })
  it('rejects unknown reason values', () => {
    expect(() => ProfanitySchema.parse({ profane: true, reason: 'reserved' })).toThrow()
  })
})
```

(This file will be largely rewritten in Task 9 to add the LLM-call coverage; for now we're just verifying the schema.)

- [ ] **Step 4: Run; confirm passes**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/profanity.test.ts`

Expected: the 4 schema tests pass. The existing reserved-list / seed-list tests in this file may still fail (they reference the old static behavior). That's expected — Task 9 deletes them.

- [ ] **Step 5: Commit**

```bash
git add backend/src/llm/prompts/auth/profanity.txt backend/src/llm/schemas/profanity.ts backend/src/llm/__tests__/profanity.test.ts
git commit -m "feat(myt-44): profanity prompt template + Zod schema"
```

---

## Task 9: Rewire `classifyProfanity`

**Files:**
- Modify: `backend/src/llm/profanity.ts`
- Modify: `backend/src/llm/__tests__/profanity.test.ts`
- Delete: `backend/src/llm/profanity-seed-en.txt`

- [ ] **Step 1: Replace the test file**

Overwrite `backend/src/llm/__tests__/profanity.test.ts` entirely:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProfanitySchema } from '../schemas/profanity.js'

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateObject: vi.fn(),
  }
})

describe('ProfanitySchema', () => {
  it('parses {profane: false}', () => {
    expect(ProfanitySchema.parse({ profane: false })).toEqual({ profane: false })
  })
  it('parses {profane: true, reason: "offensive"}', () => {
    expect(ProfanitySchema.parse({ profane: true, reason: 'offensive' })).toEqual({
      profane: true, reason: 'offensive',
    })
  })
  it('parses {profane: true, reason: "impersonation"}', () => {
    expect(ProfanitySchema.parse({ profane: true, reason: 'impersonation' })).toEqual({
      profane: true, reason: 'impersonation',
    })
  })
  it('rejects unknown reason values', () => {
    expect(() => ProfanitySchema.parse({ profane: true, reason: 'reserved' })).toThrow()
  })
})

describe('classifyProfanity', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('calls generateObject with HAIKU + ProfanitySchema + system prompt', async () => {
    const { generateObject } = await import('ai')
    const generateObjectMock = vi.mocked(generateObject)
    generateObjectMock.mockResolvedValue({
      object: { profane: false },
      usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('gandalf')

    expect(result).toEqual({ profane: false })
    expect(generateObjectMock).toHaveBeenCalledOnce()
    const callArgs = generateObjectMock.mock.calls[0]![0]!
    expect(callArgs.schema).toBe(ProfanitySchema)
    expect(callArgs.prompt).toBe('gandalf')
    expect(typeof callArgs.system).toBe('string')
    expect(callArgs.system).toContain('Reject the username')
    expect(callArgs.maxRetries).toBe(3)
  })

  it('returns the parsed object verbatim from generateObject', async () => {
    const { generateObject } = await import('ai')
    vi.mocked(generateObject).mockResolvedValue({
      object: { profane: true, reason: 'offensive' },
      usage: { inputTokens: 50, outputTokens: 8, totalTokens: 58 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('a-bad-word')
    expect(result).toEqual({ profane: true, reason: 'offensive' })
  })

  it('returns impersonation result when model classifies as such', async () => {
    const { generateObject } = await import('ai')
    vi.mocked(generateObject).mockResolvedValue({
      object: { profane: true, reason: 'impersonation' },
      usage: { inputTokens: 50, outputTokens: 9, totalTokens: 59 },
      finishReason: 'stop',
    } as never)

    const { classifyProfanity } = await import('../profanity.js')
    const result = await classifyProfanity('admin')
    expect(result).toEqual({ profane: true, reason: 'impersonation' })
  })

  it('propagates errors from generateObject', async () => {
    const { generateObject } = await import('ai')
    vi.mocked(generateObject).mockRejectedValue(new Error('boom'))

    const { classifyProfanity } = await import('../profanity.js')
    await expect(classifyProfanity('something')).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run; verify failure**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/profanity.test.ts`

Expected: FAIL — the new tests fail because `profanity.ts` is still the static-list stub.

- [ ] **Step 3: Replace `profanity.ts` body**

Overwrite `backend/src/llm/profanity.ts` entirely:

```ts
import { generateObject } from 'ai'
import { HAIKU } from './models.js'
import { ProfanitySchema, type ProfanityResult } from './schemas/profanity.js'
import { loadPrompt } from './prompts.js'

/**
 * Classify a username for offensive content or impersonation.
 *
 * Single Haiku call covering both rejection categories. The system prompt
 * (loaded from `prompts/auth/profanity.txt`) instructs the model to set
 * reason='offensive' for profanity/slurs/sexual content/hate speech, or
 * reason='impersonation' for system roles, Mythrun brand/staff, or
 * technical identifiers. If both apply, the prompt prefers 'offensive'.
 *
 * Returns the model's structured object verbatim. Errors propagate as
 * Mythrun-typed LLM errors (the middleware layer in models.ts maps them).
 */
export async function classifyProfanity(text: string): Promise<ProfanityResult> {
  const result = await generateObject({
    model: HAIKU,
    schema: ProfanitySchema,
    system: loadPrompt('auth', 'profanity'),
    prompt: text,
    maxRetries: 3,
  })
  return result.object
}
```

- [ ] **Step 4: Delete the seed list file**

```bash
rm backend/src/llm/profanity-seed-en.txt
```

- [ ] **Step 5: Run tests; confirm all pass**

Run: `pnpm --filter @mythrun/backend test src/llm/__tests__/profanity.test.ts`

Expected: all 8 tests (4 schema + 4 classifyProfanity) pass.

- [ ] **Step 6: Run typecheck**

Run: `pnpm --filter @mythrun/backend typecheck`

Expected: 0 errors. If routes/users.ts complains about reason values (next task fixes it), continue to Task 10 first and re-typecheck after.

- [ ] **Step 7: Commit**

```bash
git add backend/src/llm/profanity.ts backend/src/llm/__tests__/profanity.test.ts backend/src/llm/profanity-seed-en.txt
git commit -m "feat(myt-44): rewire classifyProfanity to use Haiku via generateObject"
```

---

## Task 10: Update MYT-38 onboarding handler for new reason values

**Files:**
- Modify: `backend/src/routes/users.ts`

- [ ] **Step 1: Find and update the fallback reason values**

Run: `grep -n "reason ?? 'profane'\|reason: 'profane'" backend/src/routes/users.ts`

Expected: find lines 95, 103, 228 (or similar). The current code uses `'profane'` as the fallback when `result.reason` is undefined.

- [ ] **Step 2: Update each fallback to `'offensive'`**

Edit `backend/src/routes/users.ts`. Replace:

```ts
reason: usernameProfanity.reason ?? 'profane',
```

with:

```ts
reason: usernameProfanity.reason ?? 'offensive',
```

And the same for `displayProfanity.reason ?? 'profane'` and `profanity.reason ?? 'profane'` instances.

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm --filter @mythrun/backend typecheck && pnpm --filter @mythrun/backend test src/routes/__tests__/users.test.ts`

Expected: 0 typecheck errors. The route tests may need fixture updates if they assert the fallback string — update if so.

- [ ] **Step 4: Run the full suite**

Run: `pnpm --filter @mythrun/backend test`

Expected: all tests pass. If any test asserts the old reason values (`'reserved'` / `'profane'`), update them to the new ones (`'impersonation'` / `'offensive'`).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/users.ts backend/src/routes/__tests__/users.test.ts
git commit -m "refactor(myt-44): update onboarding-route reason fallbacks for new schema values"
```

---

## Task 11: Wire `ANTHROPIC_API_KEY` into the staging ECS task definition

**Files:**
- Modify: `infra/modules/serving/main.tf`

- [ ] **Step 1: Find the existing secrets block in the task definition**

Run: `grep -n "STRIPE_SECRET_KEY\|valueFrom.*manual_secret_arns" infra/modules/serving/main.tf`

Expected: line ~161 shows the existing `{ name = "STRIPE_SECRET_KEY", valueFrom = var.manual_secret_arns["stripe-secret-key"] }` pattern. The validation already requires the `anthropic-api-key` map key; we just need to add the env var reference.

- [ ] **Step 2: Add the ANTHROPIC_API_KEY entry**

Edit `infra/modules/serving/main.tf` near line 161. Add a sibling entry to the `secrets` array:

```hcl
{ name = "ANTHROPIC_API_KEY", valueFrom = var.manual_secret_arns["anthropic-api-key"] },
```

- [ ] **Step 3: Plan and verify**

Run: `cd infra/environments/staging && terraform plan -target=module.serving 2>&1 | head -40`

Expected: plan shows a task definition revision update adding the ANTHROPIC_API_KEY secret reference. No other resources should change. If Terraform complains the secret slot doesn't exist, the staging environment's `manual_secret_arns` map needs to include `anthropic-api-key` — check `infra/environments/staging/main.tf`.

- [ ] **Step 4: Commit**

```bash
git add infra/modules/serving/main.tf
git commit -m "feat(myt-44): wire ANTHROPIC_API_KEY into staging ECS task definition"
```

---

## Task 12: Final verification

**Files:**
- (No file changes — verification only)

Per `superpowers:verification-before-completion`: don't claim done until everything passes.

- [ ] **Step 1: Full typecheck**

Run: `pnpm --filter @mythrun/backend typecheck`

Expected: 0 errors.

- [ ] **Step 2: Full lint**

Run: `pnpm --filter @mythrun/backend lint`

Expected: 0 errors. Address any warnings.

- [ ] **Step 3: Full test suite**

Run: `pnpm --filter @mythrun/backend test`

Expected: all tests pass. The new LLM-layer tests (errors, middleware, prompts, profanity) should each report green.

- [ ] **Step 4: Schema-parity sanity check**

Run: `pnpm --filter @mythrun/backend test src/db/__tests__/migrate-schema.test.ts`

Expected: PASS (no schema changes in this issue).

- [ ] **Step 5: Boot smoke (manual, requires Postgres + Redis up + ANTHROPIC_API_KEY in env)**

Run: `pnpm --filter @mythrun/backend dev`

Expected: app boots cleanly. Logs should show the existing boot probes pass; no new boot probe was added in this issue. App.ready() resolves; no error about missing ANTHROPIC_API_KEY.

If boot fails on `ANTHROPIC_API_KEY is required`, the .env.development needs the placeholder updated to a real `sk-ant-*` key.

- [ ] **Step 6: No commit (verification-only). Record in the plan that all checks passed.**

---

## Task 13: Staging smoke (Miklos action)

**Files:**
- (No code changes)

This task gates on the deploy succeeding. The previous tasks land all the code; this verifies it works against real Anthropic API.

- [ ] **Step 1: Populate the staging Secrets Manager value**

```bash
aws secretsmanager update-secret \
  --secret-id mythrun/staging/anthropic-api-key \
  --secret-string 'sk-ant-<real-test-key>' \
  --region us-east-1
```

Verify:

```bash
aws secretsmanager get-secret-value \
  --secret-id mythrun/staging/anthropic-api-key \
  --region us-east-1 \
  --query SecretString --output text | head -c 8
```

Expected: prints `sk-ant-`.

- [ ] **Step 2: Trigger a staging deploy**

Run: `gh workflow run Deploy`

Watch:

```bash
gh run watch $(gh run list --workflow=Deploy --branch=main --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Expected: green, deployment rolls forward, ECS PRIMARY task def revision advances.

- [ ] **Step 3: Smoke — clean username**

```bash
curl -X POST https://staging.mythrun.com/api/users/register \
  -H "Authorization: Bearer <test-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"username":"gandalf","displayName":"Gandalf the Grey"}'
```

Expected: 200 response. CloudWatch logs show `event: 'llm.call'`, `model: 'claude-haiku-4-5-20251001'`, positive token counts.

- [ ] **Step 4: Smoke — offensive username**

```bash
curl -X POST https://staging.mythrun.com/api/users/register \
  -H "Authorization: Bearer <test-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"username":"<a clearly offensive username>","displayName":"Test"}'
```

Expected: 400 response with body `{ code: 'username_unavailable', reason: 'offensive' }`. CloudWatch shows the same `event: 'llm.call'` log line.

- [ ] **Step 5: Smoke — impersonation**

```bash
curl -X POST https://staging.mythrun.com/api/users/register \
  -H "Authorization: Bearer <test-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"username":"mythrun_admin","displayName":"Test"}'
```

Expected: 400 with `reason: 'impersonation'`.

- [ ] **Step 6: Record outcome**

If all three smokes pass, MYT-44 is verified. Proceed with the close-loop steps in CLAUDE.md (wiki update via the AUTHORING.md subagent BEFORE the final push, then push, then flip Linear MYT-44 to Done).

If any smoke fails, the rewire is broken; investigate and patch before closing.

---

## Self-Review

**Spec coverage:** every section of the spec maps to a task —

| Spec section | Task |
|---|---|
| §1 Goal + §2 Why Vercel SDK | Tasks 2, 5, 6 ship the SDK + middleware that delivers the goal |
| §3 File structure | Mapped 1:1 in the file-structure table at the top of this plan |
| §4.1 models.ts | Task 6 |
| §4.2 middleware.ts | Tasks 3 (logger) + 5 (middleware) |
| §4.3 errors.ts | Task 4 |
| §4.4 prompts.ts | Task 7 |
| §4.5 schemas/profanity.ts | Task 8 |
| §4.6 profanity.ts rewire | Task 9 |
| §5 Data flow | Verified by Task 5's middleware tests + Task 9's profanity tests |
| §6 Error handling | Task 4 (taxonomy) + Task 5 (middleware integration) |
| §7 Configuration | Task 1 (env) + Task 11 (Terraform) |
| §8 Testing strategy | Tasks 4/5/7/9 ship the unit tests; Task 13 ships the staging smoke |
| §9 Out of scope | No tasks (deferred items) |
| §10 Done-when | Tasks 1-13 collectively |
| §11 Estimate | Plan total ≈3-6 hours per spec |

**Placeholder scan:** every step has concrete commands, expected outputs, and complete code. No "implement appropriate error handling" handwaves; the error-mapper has explicit branches for each Vercel error class. No "TBD" or "similar to Task N" — code is repeated at each step's site.

**Type consistency:** `LanguageModelV4Middleware` used consistently. `ProfanityResult` references match across the schema (Task 8), the profanity.ts return type (Task 9), and the route fallback (Task 10). `mapToMythrunError` signature is identical between Task 4's implementation and Task 5's middleware import.

**Caveat to flag at implementation time:** the `ai` package is on v6 stable as of 2026-05-07. Middleware spec version is `'v4'` per the docs queried during the brainstorm. If the implementer runs `pnpm --filter @mythrun/backend list ai` and finds a different major version, they should re-check the middleware shape against that version's docs before implementing Task 5. Per `feedback_runbooks_must_be_executed.md`, don't trust the version pin in this plan against current package state — verify.
