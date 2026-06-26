# MYT-96 — Frontend Staging Hosting + Deploy + Protected Access — Design

**Goal:** Stand up Mythrun's first frontend deploy pipeline. Host the built SPA on a private S3 bucket behind CloudFront at `staging.mythrun.com`, gated by an HTTP Basic-Auth CloudFront Function so only password-holders reach it pre-launch, auto-deployed from `main` on `frontend/**` changes, pointed at the staging backend API. **Staging only**; production hosting/deploy is a separate later ticket.

**Status:** approved in brainstorm (MYT-96); revised after a 4-lens blind review (infra / security / deploy / cost-ops). Two design calls were made with Miklos: the gate mechanism (CloudFront Function Basic-Auth) and the staging auth posture (realistic JWT).

---

## 1. Context — the gap

The backend deploys to staging (ECS, via `.github/workflows/deploy.yml`), but the React app has **nowhere to land** — no S3 hosting, no CloudFront distribution, no deploy workflow. The CloudFront/S3-frontend resources were scoped into the original Ops-Foundation `observability` Terraform module, which was reorganized away and never built (`docs/specs/2026-04-20-setup-guide.md` step 4.2, left unchecked). The live infra is backend-only. This blocks the entire "look at it in staging before deploying" workflow for the frontend.

**Already solved (confirmed by recon + blind review) — do NOT rebuild these:**

- **ACM cert:** the single `us-east-1` wildcard cert `*.mythrun.com` + apex (`infra/modules/dns/main.tf:97-139`, exposed as `wildcard_cert_arn` at `infra/environments/shared/outputs.tf:64`) already covers `staging.mythrun.com` and is CloudFront-eligible (CloudFront requires `us-east-1`; the whole stack is `us-east-1`). **Reuse it — no new cert.** The zone id (`dns_zone_id`, `shared/outputs.tf:51`) is likewise already exported — **no new outputs needed.**
- **Backend CORS:** already wired to `https://staging.mythrun.com` across all three surfaces (MYT-38) — the `loadEnv` host allowlist (`backend/src/config/env.ts:112`), the ECS task-def env (`infra/modules/serving/main.tf:157` ← `staging/main.tf:133`), and the test setup. **No CORS change needed.** (CORS is browser-only and is NOT the API's access-control boundary — see §3.2.)
- **Deploy pattern:** `deploy.yml` is the template — GitHub OIDC assuming `arn:aws:iam::${AWS_ACCOUNT_ID}:role/mythrun-github-actions-staging`, bound to GitHub Environment `staging`, `us-east-1`, pinned action SHAs, a concurrency group, and a pre-flight var guard. The trust policy (`staging/main.tf:442-498`) pins repo / `environment=staging` / `ref=refs/heads/main` / `sub` but NOT a workflow filename — **a new `environment: staging` job on `main` is admitted with no trust-policy change.**

---

## 2. Architecture

```
REQUEST   Safari ──HTTPS (*.mythrun.com cert)──> CloudFront  (staging.mythrun.com)
                              │ viewer-request CloudFront Function (runs on cache hits too):
                              │   read expected credential from KeyValueStore
                              │   compare request Authorization: Basic header
                              │   → 401 + WWW-Authenticate if missing/mismatch (never hits S3; fail-closed)
                              │ SPA fallback: S3 403/404 → custom-error → /index.html (200)
                              └─Origin Access Control (sigv4/always)─> private S3 bucket (built SPA, dist/)

          the app's own API calls go cross-origin → https://staging-api.mythrun.com
          (separate origin, NOT behind this gate — the API enforces its own JWT server-side; CORS already allows it.
           The browser's cached Basic credential for staging.mythrun.com is never sent to the API origin.)

DEPLOY    push→main (paths: frontend/**, the workflow)  ─or workflow_dispatch (from main)─>  deploy-frontend.yml
            → pre-flight: assert vars.STAGING_FRONTEND_BUCKET / _DISTRIBUTION_ID are set (fail fast, actionable)
            → pnpm install (scoped) → pnpm --filter @mythrun/contract build  (dist/ is gitignored)
            → pnpm --filter @mythrun/web typecheck && test    (no shortcuts — verify before shipping)
            → pnpm --filter @mythrun/web build   [VITE_API_BASE_URL=https://staging-api.mythrun.com]
            → OIDC assume mythrun-github-actions-staging  (environment: staging, us-east-1)
            → aws s3 sync frontend/dist/ s3://<bucket> --exclude index.html       (ADDITIVE — no --delete)
                 (hashed assets: Cache-Control immutable long max-age)
            → aws s3 cp index.html → no-cache
            → aws cloudfront create-invalidation --paths /index.html
          (concurrency-grouped, cancel-in-progress:false; old hashed assets pruned by a trailing pass / S3 lifecycle)
```

**Two independent auth layers** (do not conflate):

| Layer | Mechanism | Gates | Built in |
|---|---|---|---|
| **CloudFront Basic-Auth** | the password prompt | reaching the staging *site* at all | **MYT-96** |
| **App auth (JWT / Cognito)** | the app's real login + the API's server-side `AUTH_MODE=real` | the *authed screens* + the staging *API* | MYT-84 |

The password gets you *in to look*. The app's own auth (later) governs *doing things*: even past the prompt, the prod build runs in JWT mode, so authed routes (home, play, …) redirect to sign-in until MYT-84 lands.

---

## 3. Decisions

### 3.1 Gate = CloudFront Function Basic-Auth, credential out-of-band

A **CloudFront Function** (viewer-request) does HTTP Basic-Auth, with the expected credential held in a **CloudFront KeyValueStore**, set **out-of-band** via the AWS CLI (never in git or TF state). *Why:* works from any network (laptop anywhere — no IP juggling), effectively free (CloudFront Functions, not Lambda@Edge), keeps the secret out of git, one toggle to remove at launch. *Rejected:* WAF IP allowlist (laptop IP changes → brittle, plus monthly cost); Lambda@Edge (heavier — `us-east-1` replication + versioning — and costlier for the identical outcome).

The gate is a **module input** (`enable_basic_auth`, default `true`), `count`-toggled on the function + KVS + association — so the deferred prod reuse turns it off with a one-line tfvars flip, NOT a shared-module edit.

### 3.2 Staging auth posture = realistic JWT

The staging build is the prod `vite build` → JWT mode. Public screens (landing / sign-in / 404) + the app shell are visible; authed routes redirect to sign-in until MYT-84. *Why:* the frontend should mirror prod (defense-in-depth), and a dev-bypass build buys nothing — **the staging API already rejects the dev-sub bypass server-side, independent of any frontend choice**: the deploy gate forces `AUTH_MODE=real` (`.github/workflows/deploy.yml:202-217`), `AUTH_MODE=bypass` requires `NODE_ENV ∈ {development,test}` so production-staging can't even boot in bypass (`backend/src/config/env.ts:223`), and the serving module pins it (`backend/src/auth/bypass-plugin.ts`). So a dev-bypass frontend would just make calls the API 401s. We ship realistic JWT because it mirrors prod and is correct defense-in-depth — **not** because the frontend posture is load-bearing for API security (it is not; do not relax the server gate on that assumption).

### 3.3 Other decisions

- **URL = `staging.mythrun.com`** — already the CORS-wired origin and covered by the wildcard cert.
- **Reuse the `*.mythrun.com` wildcard cert** and the already-exported `dns_zone_id` — no new ACM cert, no new outputs.
- **New reusable Terraform module** `infra/modules/frontend-hosting/` — environment-parameterized so production reuses it. It takes a single `site_domain` FQDN input (e.g. `staging.mythrun.com`, later `mythrun.com`) rather than `subdomain`+`domain` (which can't express the prod apex).
- **Separate deploy workflow** `deploy-frontend.yml` — frontend deploys are independent of the backend; `deploy.yml` already path-ignores `frontend/**` (no double-fire).

---

## 4. Components

### 4.1 Terraform module `infra/modules/frontend-hosting/`

A self-contained module (the network/data/serving pattern: `main.tf` / `variables.tf` / `outputs.tf`).

- **S3 bucket** — private SPA artifact store. `aws_s3_bucket` + `aws_s3_bucket_public_access_block` (all four blocks `true`) + a bucket policy granting `s3:GetObject` **only** to `cloudfront.amazonaws.com` under the condition `AWS:SourceArn = <distribution arn>` via OAC. No website hosting config.
- **CloudFront Origin Access Control** (`aws_cloudfront_origin_access_control`, `signing_behavior = "always"`, sigv4) — the modern OAI replacement. `always` is load-bearing: the viewer-request function passes the request through still carrying the viewer's `Authorization: Basic` header, and `always` *overrides* that header with CloudFront's SigV4 on the origin request, so the Basic header never reaches S3 and origin signing works. The distribution origin uses the bucket's **regional** REST endpoint (`bucket_regional_domain_name`), not the global/website endpoint.
- **CloudFront distribution** (`aws_cloudfront_distribution`):
  - origin = the S3 regional REST endpoint, `origin_access_control_id` = the OAC.
  - `aliases = [var.site_domain]`; `viewer_certificate` = the wildcard cert arn, `minimum_protocol_version = TLSv1.2_2021`, `ssl_support_method = sni-only`.
  - `default_root_object = "index.html"`; `price_class = "PriceClass_100"`; HTTP→HTTPS redirect; compression on.
  - **SPA fallback** via two `custom_error_response` blocks: `403 → /index.html (200)` and `404 → /index.html (200)`. The **403 mapping is load-bearing**: a private OAC bucket (GetObject only, no ListBucket) returns **403** for missing deep-link keys, not 404. The Basic-Auth `401` is emitted by the function *before* the origin, so it is unaffected by these origin-error rules.
  - **cache** — the AWS-managed `CachingOptimized` policy (does NOT forward `Authorization` to the cache key or origin — keep it that way; do not attach an origin-request policy that forwards `Authorization`, or OAC signing breaks). Freshness comes from per-object `Cache-Control` at upload **plus** the explicit `/index.html` invalidation — under `CachingOptimized` (minTTL 1s) the invalidation is the load-bearing guarantee that a new deploy is picked up, not belt-and-suspenders.
  - **function association** — `viewer-request` → the Basic-Auth function (when `enable_basic_auth`). **Module invariant:** if ordered cache behaviors are ever added, each must carry the same `viewer-request` association, or it is a bypass path.
- **Route 53** — `aws_route53_record` A-alias `var.site_domain` → the distribution, into the shared hosted zone (`var.hosted_zone_id`).
- **Inputs:** `site_domain` (FQDN), `acm_certificate_arn`, `hosted_zone_id`, `environment`, `enable_basic_auth` (default `true`). **Outputs:** `bucket_name`, `distribution_id`, `distribution_arn`, `url`, `kvs_arn` (when `enable_basic_auth`).

### 4.2 The gate — CloudFront Function + KeyValueStore

- **`aws_cloudfront_key_value_store`** (`count = var.enable_basic_auth ? 1 : 0`) — created **empty** by Terraform. Holds one key, the fixed module constant `staging-basic-auth`, whose value is the expected header `Basic <base64(user:password)>`. **The value is set out-of-band** (§5) — never in git or TF state. (The key name is a fixed module constant, not an input — a static `.js` function can't honor a per-call input; documented here so there's no phantom variable.)
- **`aws_cloudfront_function`** (runtime `cloudfront-js-2.0`, which supports KVS), associated with the KVS. The committed source contains **no secret** — only lookup + comparison:

  ```js
  import cf from 'cloudfront';
  const kvs = cf.kvs();
  async function handler(event) {
    const req = event.request;
    const sent = req.headers.authorization && req.headers.authorization.value;
    let expected;
    try { expected = await kvs.get('staging-basic-auth'); } catch (e) { expected = null; }
    if (sent && expected && sent === expected) return req; // pass through to origin
    return {
      statusCode: 401,
      statusDescription: 'Unauthorized',
      headers: { 'www-authenticate': { value: 'Basic realm="Mythrun staging"' } },
    };
  }
  ```

  **Fail-closed in every branch:** missing/empty `Authorization` → 401; KVS read throws → caught → `expected=null` → 401; key unset → `expected` falsy → 401 (does not depend on `kvs.get`'s missing-key semantics). The site is never accidentally open — the worst failure mode is a 401 nobody can pass (a locked-out staging, not an exposed one). The `===` can only over-reject; a timing side-channel on a TLS-protected shared staging password is not a real threat.

### 4.3 Deploy workflow `.github/workflows/deploy-frontend.yml`

- **Trigger:** `push` to `main` with `paths: ['frontend/**', '.github/workflows/deploy-frontend.yml']` + `workflow_dispatch` (must run from `main` — the trust policy pins `ref=refs/heads/main`).
- **`concurrency:`** `{ group: deploy-mythrun-staging-frontend, cancel-in-progress: false }` (mirrors `deploy.yml`) so two near-simultaneous `main` pushes don't interleave the bucket sync.
- **One job, `deploy-staging`**, `environment: staging`, `permissions: id-token: write, contents: read`, pinned action SHAs.
- **Steps:**
  1. **Pre-flight** (mirror `deploy.yml:108-113`): assert `vars.STAGING_FRONTEND_BUCKET` + `vars.STAGING_FRONTEND_DISTRIBUTION_ID` are non-empty; fail fast with an actionable message (avoids a `s3 sync … s3:///` against an empty name on a pre-bootstrap run).
  2. checkout → pnpm + Node setup → scoped install: `pnpm install --frozen-lockfile --filter @mythrun/web... --filter @mythrun/ui... --filter @mythrun/client-core... --filter @mythrun/contract...`.
  3. **`pnpm --filter @mythrun/contract build`** — `@mythrun/contract`'s exports map to `./dist/*` and `frontend/contract/dist` is **gitignored**; `@mythrun/web` reaches it transitively (`client-core/src/api/*.ts` import the Zod schemas from `@mythrun/contract/rest`), so a fresh runner fails to resolve it without this. (Exactly what `frontend-check.yml:36` does.)
  4. **`pnpm --filter @mythrun/web typecheck && pnpm --filter @mythrun/web test`** — `vite build` strips types and runs no tests; the deploy must verify before shipping (the "no shortcuts on CI/deploy" constraint — `frontend-check` is a *separate* workflow that doesn't gate this one, and we push directly to `main`).
  5. **build:** `pnpm --filter @mythrun/web build` with `env: VITE_API_BASE_URL: https://staging-api.mythrun.com` (Vite reads `VITE_`-prefixed env at build; `vite build` ⇒ `import.meta.env.PROD` ⇒ the JWT seam).
  6. OIDC assume → **additive** upload (no `--delete`, so the new index never references not-yet-uploaded or just-deleted assets):
     ```bash
     aws s3 sync frontend/dist/ s3://$BUCKET/ --exclude index.html \
       --cache-control "public,max-age=31536000,immutable"
     aws s3 cp frontend/dist/index.html s3://$BUCKET/index.html \
       --cache-control "no-cache" --content-type "text/html"
     ```
     **Caveat (module invariant):** the blanket-immutable rule is safe only because `dist/` is `index.html` + content-hashed `assets/`. If a `frontend/public/` ever adds root files (`favicon.ico`, `robots.txt`, `manifest.json` — Vite copies them to dist root *unhashed*), they'd be cached immutable + un-updatable; exclude them from the immutable pass.
  7. `aws cloudfront create-invalidation --distribution-id $DIST --paths "/index.html"`.
  8. Old hashed assets from prior deploys are pruned by a trailing `aws s3 sync … --delete` pass (or an S3 lifecycle rule) — out of the hot path, so no broken-asset window.
- **Post-deploy smoke (retry loop, mirror `deploy.yml:290-311`):** `curl -s -o /dev/null -w '%{http_code}' https://staging.mythrun.com/` → assert `401` (proves the distribution is live AND the gate is on; secret-free). **Limitation:** because the function fails closed, a `401` also matches "password never set" and can't verify upload content — the `aws s3` step succeeding is the real upload guard, and the §5 password-set step is what makes the site enterable. Retry to absorb first-run CloudFront/Route53 propagation lag.
- `$BUCKET`/`$DIST` come from `terraform output` surfaced as GitHub Actions variables (set once after the first apply — see §5 bring-up order).

### 4.4 IAM + staging wiring

- **OIDC role policy** — extend `aws_iam_policy_document.gh_actions_staging` (`infra/environments/staging/main.tf:507-676`, verified currently lacking both) with two **resource-scoped** statements: `s3:PutObject` / `s3:GetObject` / `s3:DeleteObject` / `s3:ListBucket` on the new bucket arn (+ `/*`), and `cloudfront:CreateInvalidation` / `cloudfront:GetInvalidation` on the new distribution arn. No wildcards beyond resource scope; no new role (the trust policy is unchanged); no PassRole (no ECS in this deploy).
- **Composition** — add the `module "frontend_hosting"` block in `staging/main.tf` passing `site_domain = "staging.mythrun.com"`, the already-exported `wildcard_cert_arn` + `dns_zone_id`, `environment`, `enable_basic_auth = true`; surface `bucket_name` + `distribution_id` + `url` through `staging/outputs.tf`.

---

## 5. Operating this piece (runbooks)

- **First bring-up order (one-time, sequenced):**
  1. `terraform apply` (creates the bucket, distribution, KVS, function, Route 53 record, IAM grants).
  2. Read `terraform output` → set GitHub Actions variables `STAGING_FRONTEND_BUCKET` and `STAGING_FRONTEND_DISTRIBUTION_ID`.
  3. Set the Basic-Auth password (below) — **required** before the site is enterable; the `401` smoke will pass without it but nobody can get in.
  4. Trigger the first deploy (`workflow_dispatch` from `main`). The pre-flight guard (§4.3) protects against running before steps 2–3.
- **Set / rotate the staging password:**
  ```bash
  CRED="Basic $(printf 'mythrun:<chosen-password>' | base64 | tr -d '\n')"   # tr strips base64's 76-col wrap
  ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn "$KVS_ARN" --query ETag --output text)
  aws cloudfront-keyvaluestore put-key --kvs-arn "$KVS_ARN" \
    --key staging-basic-auth --value "$CRED" --if-match "$ETAG"
  ```
  Takes effect within ~a minute (KVS propagation). The password lives only here — never committed. Optional post-set verify: `curl -u mythrun:<password> https://staging.mythrun.com/` → `200`.
- **Manual deploy:** `workflow_dispatch` on `deploy-frontend.yml`, **from `main`** (OIDC trust pins `ref=main`).
- **Remove the gate at launch:** flip `enable_basic_auth = false` in the prod/staging tfvars (one line) — the function + KVS + association `count` to 0. The site becomes public; the app's own JWT auth remains.

---

## 6. Done when / deferred

**Done when:** `https://staging.mythrun.com` serves the built SPA behind the Basic-Auth gate, reachable from Miklos's laptop on any network with the password, pointed at `staging-api.mythrun.com`, and auto-redeploys on `frontend/**` pushes to `main` (the workflow building cleanly on a fresh runner, verifying typecheck+test, with no broken-asset window).

**Deferred (out of scope):** production hosting/deploy (a later ticket, likely the Launch milestone — the `enable_basic_auth`-toggled, `site_domain`-parameterized module makes it cheap); the authed screens (MYT-84 login); a per-user staging gate (the shared password is sufficient pre-launch).

---

## 7. Constraints

- **Core infra — no shortcuts** (CI/deploy pipelines, IAM, DNS). The deploy verifies (typecheck + test + the contract pre-build) before it ships, mirrors `deploy.yml`'s OIDC + `environment: staging` + concurrency + pre-flight discipline, and pins all action SHAs.
- The Basic-Auth **credential is never in git or TF state** — KVS, set out-of-band; the committed function carries only logic and fails **closed**.
- **Reuse** the wildcard cert, the existing zone outputs, and the existing OIDC role/trust; do not mint a second cert or role, or add duplicate outputs.
- IAM additions are **resource-scoped** to the new bucket + distribution — no account-wide `s3:*` / `cloudfront:*`.
- The module is **environment-parameterized** (`site_domain` FQDN + `enable_basic_auth` toggle; no `staging` hardcoded) so production reuses it with the gate off and the apex domain.
- **OAC invariant:** do not forward `Authorization` to the S3 origin (keep `CachingOptimized` / no origin-request `Authorization` policy), or OAC signing breaks. Every cache behavior carries the `viewer-request` function.
