# MYT-44 — LLM client + Anthropic SDK wrapper layer

**Status:** Design approved 2026-05-07. Implementation next.

## 1. Goal

Land the foundation that every Mythrun LLM call site sits on top of. Today the production codebase has zero Anthropic SDK code; this ticket fills that hole and rewires the only existing LLM-shaped consumer (the MYT-38 `classifyProfanity` stub) to use the real wrapper.

The wrapper is built on top of **Vercel AI SDK v6** (`ai` + `@ai-sdk/anthropic`) — the industry-standard provider-abstraction layer for JS. The SDK itself handles provider mechanics; Mythrun-owned code is limited to model definitions, a logging-and-error-normalization middleware, an error taxonomy, a prompt-template loader, and the rewired profanity classifier.

## 2. Why Vercel AI SDK (vs own adapter)

The decisive factor is what's coming next in the milestone queue. Streaming (Fast Thinker) and tool use (Slow Thinker) both land in the Session Runtime milestone; they're the heaviest LLM concerns on Mythrun's roadmap, and they're exactly what Vercel SDK is built for. An own-adapter approach would defer ~2–3 days of streaming + tool-use plumbing into those tickets; using Vercel SDK reduces both to thin wrappers.

The provider-agnostic shape Vercel imposes also addresses the durability concern: if Mythrun ever wants to use OpenAI, Gemini, or Deepseek for specific tasks, adding the provider is `pnpm add @ai-sdk/<provider>` + a new wrapped model constant. No adapter code to write, no call-site changes.

We don't lock in irreversibly: callers use Vercel's `generateText` / `generateObject` directly, so if we ever decide the SDK gets in the way, swapping to direct Anthropic SDK calls is a per-file mechanical refactor.

## 3. File structure

```
backend/src/llm/
├── models.ts              # HAIKU/SONNET/OPUS as wrapLanguageModel-wrapped
├── middleware.ts          # logAndNormalizeMiddleware factory
├── errors.ts              # 7 typed error classes + mapToMythrunError
├── prompts.ts             # loadPrompt(area, name, vars) — file utility
├── prompts/
│   └── auth/
│       └── profanity.txt
├── schemas/
│   └── profanity.ts       # ProfanitySchema (Zod)
├── profanity.ts           # rewired classifyProfanity using generateObject
└── __tests__/
    ├── middleware.test.ts
    ├── prompts.test.ts
    └── profanity.test.ts
```

Total Mythrun-owned code: ~250–300 lines.

**Files deleted in this ticket:**
- `backend/src/llm/profanity-seed-en.txt` (heuristic substring matching, ZFC-violating)
- `RESERVED_USERNAMES` constant in `profanity.ts` (replaced by an LLM-based impersonation check, ZFC-compliant)

## 4. Components

### 4.1 `models.ts`

Exports the three tier-named model constants. Each is wrapped with the logging + error-normalization middleware so callers get instrumentation for free.

```ts
import { wrapLanguageModel } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { logAndNormalizeMiddleware } from './middleware.js'

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

Model IDs match `CLAUDE.md`'s pinned versions (Haiku 4.5 / Sonnet 4.6 / Opus 4.7). No call site outside `models.ts` references a model ID string — this is the single source of truth.

**Rationale — tier-named, not task-named:** Task-named aliases (`PROFANITY_CLASSIFIER`, `FAST_THINKER`, etc.) were considered. They'd add an indirection layer that lets a config swap one task's model without touching call sites. The use-case for that hasn't materialized yet, so YAGNI: tier names today, task aliases when the need shows up.

### 4.2 `middleware.ts`

Single factory returning a `LanguageModelV4Middleware` carrying the model ID for log enrichment. Wraps `doGenerate` with timing + structured logging + error normalization. `wrapStream` is omitted from this ticket (streaming deferred to Fast Thinker).

```ts
import type { LanguageModelV4Middleware } from '@ai-sdk/provider'
import { logger } from '../logging.js'  // existing pino instance
import { mapToMythrunError } from './errors.js'

export function logAndNormalizeMiddleware(modelId: string): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate, params }) => {
      const start = Date.now()
      try {
        const result = await doGenerate()
        logger.info({
          event: 'llm.call',
          model: modelId,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          latencyMs: Date.now() - start,
          finishReason: result.finishReason,
          sessionId: extractContextField(params, 'sessionId'),
          userId: extractContextField(params, 'userId'),
        }, 'llm call completed')
        return result
      } catch (err) {
        logger.error({
          event: 'llm.error',
          model: modelId,
          err,
          latencyMs: Date.now() - start,
        }, 'llm call failed')
        throw mapToMythrunError(err)
      }
    },
  }
}
```

**Logging shape:** Every successful call emits `event: 'llm.call'` at info level with `{ model, inputTokens, outputTokens, totalTokens, latencyMs, finishReason, sessionId?, userId? }`. Failed calls emit `event: 'llm.error'` with the original error preserved as `err`. MYT-43 will subscribe to these log events to write the `session_usage` table; this ticket only emits.

**Cost is deliberately not logged here.** Cost is derived data — `(tokens / 1e6) × ratePerMillion` — and Anthropic exposes no programmatic pricing API to query at runtime. Hardcoding rates in this module would create a second source of truth that drifts from MYT-43's rate map. Instead: middleware emits raw tokens + the model ID, and downstream consumers (CloudWatch dashboards, MYT-43's `session_usage` writer) compute cost from rate maps maintained where they're already needed. The `model` field is the discriminator that lets retrospective analysis attribute spend to Haiku vs Sonnet vs Opus correctly.

**`sessionId` / `userId` threading:** Callers pass these through `providerOptions.mythrun = { sessionId, userId }`. The middleware reads them out of `params.providerOptions.mythrun` and includes them in the log line. Calls without context fields just have undefined for those keys. The `mythrun` namespace in `providerOptions` avoids collision with provider-specific options like `providerOptions.anthropic.cacheControl`.

### 4.3 `errors.ts`

Seven typed error classes plus a mapper from Vercel's error taxonomy.

```ts
export class LlmRateLimitedError extends Error { /* maps from TooManyRequestsError */ }
export class LlmOverloadedError extends Error { /* statusCode 529 from APICallError */ }
export class LlmContextTooLongError extends Error { /* 400 with context-window code */ }
export class LlmAuthError extends Error { /* 401 from APICallError */ }
export class LlmInvalidRequestError extends Error { /* other 400s */ }
export class LlmTimeoutError extends Error { /* AbortError */ }
export class LlmStructuredOutputError extends Error { /* AI_NoObjectGeneratedError */ }

export function mapToMythrunError(err: unknown): Error {
  // pattern-match Vercel's error classes by instanceof + statusCode
  // rethrow as the appropriate Mythrun class with cause: err
  // unknown errors pass through as-is (let Fastify's default handler take them)
}
```

Route handlers catch only Mythrun classes and never see `APICallError` / `TooManyRequestsError` / `AI_NoObjectGeneratedError`. HTTP status mapping happens at the route handler:

| Mythrun error | HTTP status |
|---|---|
| `LlmRateLimitedError` | 429 |
| `LlmOverloadedError` | 503 |
| `LlmTimeoutError` | 504 |
| `LlmAuthError` | 503 (server misconfigured, not a client error) |
| `LlmContextTooLongError` | 400 |
| `LlmInvalidRequestError` | 400 |
| `LlmStructuredOutputError` | 502 (provider returned unparseable output) |

### 4.4 `prompts.ts`

Standalone file utility with no SDK dependency. Loads `.txt` templates from `backend/src/llm/prompts/<area>/<name>.txt` and interpolates `{{variable}}` placeholders.

```ts
const cache = new Map<string, string>()

export function loadPrompt(
  area: string,
  name: string,
  vars?: Record<string, string>,
): string {
  const key = `${area}/${name}`
  let template = cache.get(key)
  if (template === undefined) {
    template = readFileSync(promptPath(area, name), 'utf-8')
    cache.set(key, template)
  }
  return interpolate(template, vars ?? {})
}
```

Cached on first read; the cache is process-scoped so a deploy starts fresh. Missing files throw on first load; the boot-time smoke test below catches missing prompts before requests arrive.

### 4.5 `schemas/profanity.ts`

```ts
import { z } from 'zod'

export const ProfanitySchema = z.object({
  profane: z.boolean(),
  reason: z.enum(['offensive', 'impersonation']).optional(),
})
export type ProfanityResult = z.infer<typeof ProfanitySchema>
```

The `reason` enum captures the two rejection categories: `offensive` (profanity, slurs, sexual content, hate speech) and `impersonation` (system roles, Mythrun brand or staff, technical identifiers). The model picks one when rejecting; `offensive` wins ties.

This is a contract change from the existing stub's `'reserved' | 'profane'` enum. The new categories are conceptually similar but renamed for clarity:
- `'reserved'` → `'impersonation'` (more accurate name for what's being blocked)
- `'profane'` → `'offensive'` (broader category, includes profanity + slurs + sexual content)

Existing MYT-38 callers that use `result.reason` in logging see the new values. No control-flow callers need to change.

### 4.6 `profanity.ts` (rewired)

```ts
import { generateObject } from 'ai'
import { HAIKU } from './models.js'
import { ProfanitySchema, type ProfanityResult } from './schemas/profanity.js'
import { loadPrompt } from './prompts.js'

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

Single Haiku call covers both impersonation and offensive content. The system prompt at `backend/src/llm/prompts/auth/profanity.txt`:

```
You classify usernames for an online D&D platform. Reject the username if:

1. It contains offensive content: profanity, slurs, sexual content, hate
   speech, or explicit references to violence. Set reason='offensive'.

2. It impersonates: a system role (admin, support, moderator, root), the
   Mythrun brand or staff, or a technical identifier (noreply, null,
   undefined, system). Set reason='impersonation'.

Otherwise set profane=false. If both apply, prefer 'offensive'.
```

The function name `classifyProfanity` is now a slight misnomer — it does both impersonation and offensive checks. Renaming was considered and rejected to keep MYT-44 scope-tight; the rename is a separate small refactor for whoever wants it.

**Cost ballpark:** ~50 input tokens (system + username) + ~10 output tokens per call, at Haiku pricing (~$1/M input, ~$5/M output as of 2026): ~$0.0001 per username registration. For 10K registrations/month: ~$1/month. Trivially cheap.

## 5. Data flow

For a typical `classifyProfanity` call:

1. Caller invokes `classifyProfanity(username)`.
2. Function calls `generateObject({ model: HAIKU, schema, system, prompt, maxRetries: 3 })`.
3. Vercel SDK serializes the request, applies any `transformParams` middleware (none in this ticket), and calls the underlying language model.
4. The model object is `wrapLanguageModel(...)`-wrapped, so `wrapGenerate` middleware fires.
5. Middleware records start timestamp, calls `await doGenerate()`.
6. SDK retries on transient failures up to `maxRetries` times. Each retry is a fresh call from the SDK's perspective; the middleware's outer `try` only sees the final outcome.
7. On success: middleware logs `event: 'llm.call'` with usage + latency, returns the result up the SDK call chain. SDK runs schema validation; success returns the Zod-parsed object.
8. On failure: middleware logs `event: 'llm.error'`, calls `mapToMythrunError(err)`, throws the Mythrun-typed error.

## 6. Error handling

**Retry policy:** Vercel SDK's built-in retry with `maxRetries: 3`. The SDK uses exponential backoff with jitter and skips retries for non-retryable status codes (4xx). We don't override this — Vercel's defaults are well-tuned per provider.

**Abort signal:** Callers can pass `abortSignal: AbortSignal.timeout(ms)` on any `generateText` / `generateObject` call. Vercel SDK threads it through the entire pipeline. The middleware catches `AbortError` and rethrows as `LlmTimeoutError`.

**Schema-fail handling:** When `generateObject` can't produce a valid object (model returned non-JSON, JSON didn't match schema, or model refused), Vercel SDK throws `AI_NoObjectGeneratedError` after its own retry attempts. Our middleware maps this to `LlmStructuredOutputError`. Routes return 502 (provider returned unparseable output).

**Unknown errors:** Anything not matched by `mapToMythrunError` passes through as-is. Fastify's default error handler catches it, logs, returns 500.

## 7. Configuration

### 7.1 `backend/src/config/env.ts`

Add a required field:

```ts
export interface Env {
  // ... existing
  readonly anthropicApiKey: string
}
```

`loadEnv()` validates `ANTHROPIC_API_KEY` is set and non-empty. Boot fails if missing.

### 7.2 Local dev

`backend/.env.development.example` adds `ANTHROPIC_API_KEY=sk-ant-REPLACE_ME_dev_only` as a placeholder. Local developers populate with a real key from their Anthropic Console.

### 7.3 Staging / production

`mythrun/staging/anthropic-api-key` already exists in AWS Secrets Manager (created in MYT-30 / MYT-35 wiring). Populate via `aws secretsmanager update-secret`. The ECS task definition reads it via `secrets:` and exposes as `ANTHROPIC_API_KEY` env var. Production analog: `mythrun/prod/anthropic-api-key`.

### 7.4 Vercel SDK provider initialization

The `@ai-sdk/anthropic` provider reads `ANTHROPIC_API_KEY` from the environment automatically. No explicit factory call needed in `models.ts`.

## 8. Testing strategy

**Unit tests use `vi.mock` at the SDK boundary.** Tests don't hit the network. Mocks return deterministic fixtures.

```ts
import { vi } from 'vitest'

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai')
  return {
    ...actual,
    generateObject: vi.fn(),
  }
})
```

Test surfaces:

1. **`middleware.test.ts`:** middleware fires logging on success, fires error logging + rethrows mapped error on failure, threads sessionId/userId through provider options.
2. **`prompts.test.ts`:** `loadPrompt` reads the file, caches it, interpolates `{{vars}}`, throws on missing file.
3. **`profanity.test.ts`:** `classifyProfanity` calls `generateObject` with HAIKU + schema + loaded prompt. The SDK is mocked; assertions are on the call shape, not the network.

**Staging smoke (manual, gated on the deploy passing):**

After `pnpm deploy` to staging with `ANTHROPIC_API_KEY` populated:
1. `POST /api/users/register` with a clean username → expect 200, log line `event: 'llm.call'` with model=`claude-haiku-4-5-20251001` and tokens > 0.
2. `POST /api/users/register` with an offensive username (e.g., a clear slur) → expect 400, response body `{ error: 'username_unavailable', reason: 'offensive' }`.
3. `POST /api/users/register` with an impersonation attempt (e.g., `mythrun_admin`) → expect 400, `reason: 'impersonation'`.

If any of those fails, the rewire is broken; investigate before considering the ticket done.

## 9. Out of scope

Per the issue body and downstream-ticket assignments:

- **Streaming responses (SSE).** Deferred to the Fast Thinker ticket. `wrapStream` middleware coverage lands when streaming is actually needed.
- **Tool use.** Deferred to the Slow Thinker ticket. Vercel SDK's `tools: {...}` API is available when needed; this ticket doesn't use it.
- **Per-session usage table writes.** MYT-43 owns this. The middleware emits structured log events with all the data MYT-43 needs (`event: 'llm.call'`, model, tokens, sessionId); MYT-43 subscribes via a log handler or queries the `session_usage` table at write-time.
- **Multi-modal inputs (images, audio).** Vercel SDK supports them; we don't use them yet.
- **Prompt caching as a default.** `providerOptions.anthropic.cacheControl: { type: 'ephemeral' }` is available to callers who want it but MYT-44 doesn't enable it anywhere by default. Pipeline / FT / ST tickets will turn it on for their hot-path system prompts when they land.

## 10. Done-when

- [ ] `pnpm add ai @ai-sdk/anthropic` (root + backend workspace as appropriate)
- [ ] `ANTHROPIC_API_KEY` added to `Env` in `backend/src/config/env.ts` as a required field; loadEnv validates
- [ ] `backend/.env.development.example` carries the placeholder
- [ ] AWS Secrets Manager `mythrun/staging/anthropic-api-key` populated and wired into the ECS task definition (verify via `aws secretsmanager get-secret-value ... | head -c 12` → expect `sk-ant-`)
- [ ] `backend/src/llm/{models,middleware,errors,prompts}.ts` ship per §4
- [ ] `backend/src/llm/schemas/profanity.ts` ships
- [ ] `backend/src/llm/prompts/auth/profanity.txt` ships with the system prompt verbatim from §4.6
- [ ] `backend/src/llm/profanity.ts` rewired per §4.6; `RESERVED_USERNAMES` constant + `profanity-seed-en.txt` deleted
- [ ] MYT-38 onboarding handler updated to use new `'offensive'` / `'impersonation'` reason values
- [ ] Unit tests pass: middleware, prompts, profanity (all SDK-mocked)
- [ ] `pnpm typecheck && pnpm lint && pnpm test` clean
- [ ] Staging deploy succeeds, all three smoke scenarios from §8 pass
- [ ] Wiki: a new page or section on the LLM layer (likely under `auth-billing/` or a new `runtime/llm.html`) lands with the AUTHORING.md subagent before the final push
- [ ] Linear MYT-44 → Done after wiki + push

## 11. Estimate

Originally scoped at 2–3 working days assuming we built our own adapter. With Vercel AI SDK doing the heavy lifting, ~3–6 hours of careful implementation + testing + staging smoke. The middleware is the most novel piece (~80 lines). Everything else is mechanical wiring around proven SDK APIs.
