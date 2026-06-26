# MYT-96 — Frontend Staging Hosting + Deploy + Protected Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host the built React SPA on a private S3 bucket behind CloudFront at `staging.mythrun.com`, gated by an HTTP Basic-Auth CloudFront Function, auto-deployed from `main` on `frontend/**` changes, pointed at the staging backend API.

**Architecture:** A new reusable Terraform module `infra/modules/frontend-hosting/` provisions a private S3 bucket + CloudFront distribution (OAC origin signing, SPA 403/404 fallback) + a `count`-toggled Basic-Auth gate (CloudFront Function + KeyValueStore, password set out-of-band). A separate `deploy-frontend.yml` workflow (OIDC into the existing `mythrun-github-actions-staging` role, `environment: staging`) builds the SPA against the staging API and does an additive S3 upload + `/index.html` invalidation. The shared `*.mythrun.com` wildcard cert and the already-exported `dns_zone_id` are reused — no new cert, no new shared outputs, no new IAM role.

**Tech Stack:** Terraform (`hashicorp/aws ~> 6.0`), AWS S3 + CloudFront (OAC + Functions runtime `cloudfront-js-2.0` + KeyValueStore) + Route 53, GitHub Actions (OIDC), pnpm + Vite (`@mythrun/web`), Node 24 `node:test` for the CloudFront Function unit test.

## Global Constraints

_(Spec §7, verbatim-ish. Every task's requirements implicitly include this section.)_

- **Core infra — no shortcuts** (CI/deploy pipelines, IAM, DNS). The deploy verifies (typecheck + test + the contract pre-build) before it ships, mirrors `deploy.yml`'s OIDC + `environment: staging` + concurrency + pre-flight discipline, and pins all action SHAs.
- The Basic-Auth **credential is never in git or TF state** — KVS, set out-of-band; the committed function carries only logic and fails **closed**.
- **Reuse** the wildcard cert, the existing zone outputs, and the existing OIDC role/trust; do not mint a second cert or role, or add duplicate outputs.
- IAM additions are **resource-scoped** to the new bucket + distribution — no account-wide `s3:*` / `cloudfront:*`.
- The module is **environment-parameterized** (`site_domain` FQDN + `enable_basic_auth` toggle; no `staging` hardcoded) so production reuses it with the gate off and the apex domain.
- **OAC invariant:** do not forward `Authorization` to the S3 origin (keep `CachingOptimized` / no origin-request `Authorization` policy), or OAC signing breaks. Every cache behavior carries the `viewer-request` function.
- **Pinned action SHAs** (copy verbatim from `deploy.yml` / `frontend-check.yml`):
  - `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2`
  - `pnpm/action-setup@903f9c1a6ebcba6cf41d87230be49611ac97822e # v6.0.3`
  - `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0`
  - `aws-actions/configure-aws-credentials@d979d5b3a71173a29b74b5b88418bfda9437d885 # v6.1.1`
- **Fixed values:** region `us-east-1`; OIDC role `arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging`; site `https://staging.mythrun.com`; API `https://staging-api.mythrun.com`; KVS key constant `staging-basic-auth`; CloudFront alias hosted-zone constant `Z2FDTNDATAQYW2`.

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `infra/modules/frontend-hosting/functions/basic-auth.js` | T1 | Deployed CloudFront Function source (no secret, fail-closed). |
| `infra/modules/frontend-hosting/functions/__tests__/basic-auth.test.mjs` | T1 | `node:test` unit test of the 4 fail-closed branches + pass-through. |
| `infra/modules/frontend-hosting/functions/__tests__/cloudfront-test-loader.mjs` | T1 | `--import` entry that registers the resolve/load hook. |
| `infra/modules/frontend-hosting/functions/__tests__/cloudfront-resolve-hook.mjs` | T1 | Virtualizes the `cloudfront` runtime module + exposes the file's `handler` to the test. |
| `infra/modules/frontend-hosting/variables.tf` | T2 | Module inputs (`site_domain`, `acm_certificate_arn`, `hosted_zone_id`, `environment`, `enable_basic_auth`). |
| `infra/modules/frontend-hosting/main.tf` | T2 | S3 + OAC + bucket policy + CloudFront distribution + gate (function/KVS) + Route 53. |
| `infra/modules/frontend-hosting/outputs.tf` | T2 | `bucket_name`, `distribution_id`, `distribution_arn`, `url`, `kvs_arn`. |
| `infra/environments/staging/main.tf` | T3 | Extend `gh_actions_staging` IAM doc (2 statements) + add `module "frontend_hosting"`. |
| `infra/environments/staging/outputs.tf` | T3 | Surface bucket / distribution id / url / kvs arn. |
| `.github/workflows/deploy-frontend.yml` | T4 | The frontend deploy pipeline. |

---

### Task 1: CloudFront Function + unit test (TDD)

**Files:**
- Create: `infra/modules/frontend-hosting/functions/basic-auth.js`
- Test: `infra/modules/frontend-hosting/functions/__tests__/basic-auth.test.mjs`
- Test infra: `infra/modules/frontend-hosting/functions/__tests__/cloudfront-test-loader.mjs`
- Test infra: `infra/modules/frontend-hosting/functions/__tests__/cloudfront-resolve-hook.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a deployed artifact `functions/basic-auth.js` whose **module-global** `async function handler(event)` returns either `event.request` (pass-through) or a `{ statusCode: 401, statusDescription, headers }` object. T2's `aws_cloudfront_function.code = file("${path.module}/functions/basic-auth.js")` reads this exact file. The file imports `cloudfront` and reads KVS key `staging-basic-auth` — **no `export`** (the CloudFront runtime invokes the global `handler`; an `export` would change the deployed artifact).

**Why the test loader (not `mock.module`):** the deployed file imports the bare specifier `cloudfront`, which only exists in the CloudFront runtime — there is no npm package. `mock.module('cloudfront', …)` fails (`ERR_MODULE_NOT_FOUND`: it resolves the real module first) and needs `--experimental-test-module-mocks`. Instead, a committed ESM resolve/load hook (a) virtualizes `cloudfront` to a stub whose `kvs().get()` reads test-controlled `globalThis.__CF_KVS_STATE__`, and (b) appends `export { handler }` to `basic-auth.js` **at load time only** — so the on-disk deployed artifact stays export-free while the test imports the real source. No experimental flag. (Verified working on Node 24/25.)

- [ ] **Step 1: Write the failing test + the two loader-hook files**

`infra/modules/frontend-hosting/functions/__tests__/cloudfront-resolve-hook.mjs`:

```js
// ESM resolve/load hooks that make the deployed CloudFront Function source
// (functions/basic-auth.js) importable + unit-testable under plain Node:
//   1. Virtualize the runtime-only `cloudfront` module. Its kvs().get() reads
//      test-controlled state from globalThis.__CF_KVS_STATE__:
//        { 'staging-basic-auth': '<expected header>' } -> returns it
//        { throw: true }                                -> throws (KVS down)
//        {}                                             -> throws KeyNotFound (key unset)
//   2. Append `export { handler }` to basic-auth.js AT LOAD TIME ONLY, so the
//      on-disk deployed artifact stays export-free (the CloudFront runtime
//      invokes the module-global `handler`, it does not import an export).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const VIRTUAL = 'virtual:cloudfront.mjs';

export async function resolve(specifier, context, next) {
  if (specifier === 'cloudfront') {
    return { url: VIRTUAL, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === VIRTUAL) {
    const source = `const cf = { kvs: () => ({ get: async (key) => {
      const s = globalThis.__CF_KVS_STATE__ || {};
      if (s.throw) throw new Error('KVS unavailable');
      if (Object.prototype.hasOwnProperty.call(s, key)) return s[key];
      throw new Error('KeyNotFound');
    } }) }; export default cf;`;
    return { format: 'module', source, shortCircuit: true };
  }
  if (url.endsWith('/basic-auth.js')) {
    const original = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source: original + '\nexport { handler };\n', shortCircuit: true };
  }
  return next(url, context);
}
```

`infra/modules/frontend-hosting/functions/__tests__/cloudfront-test-loader.mjs`:

```js
// Registers the resolve/load hook in the loader thread. Passed to node via
// `--import`. Path is relative to THIS file.
import { register } from 'node:module';

register('./cloudfront-resolve-hook.mjs', import.meta.url);
```

`infra/modules/frontend-hosting/functions/__tests__/basic-auth.test.mjs`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Imports the REAL deployed source (../basic-auth.js); the registered loader
// hook virtualizes its `cloudfront` import and appends `export { handler }`.
const { handler } = await import('../basic-auth.js');

const EXPECTED = 'Basic bXl0aHJ1bjpzM2NyZXQ='; // base64('mythrun:s3cret'); test-only

beforeEach(() => {
  globalThis.__CF_KVS_STATE__ = { 'staging-basic-auth': EXPECTED };
});

const reqWith = (auth) => ({
  request: { headers: auth ? { authorization: { value: auth } } : {} },
});

test('missing Authorization header -> 401 fail-closed', async () => {
  const r = await handler(reqWith(undefined));
  assert.equal(r.statusCode, 401);
  assert.equal(r.statusDescription, 'Unauthorized');
  assert.equal(r.headers['www-authenticate'].value, 'Basic realm="Mythrun staging"');
});

test('mismatched credential -> 401', async () => {
  const r = await handler(reqWith('Basic d3Jvbmc='));
  assert.equal(r.statusCode, 401);
});

test('KVS read throws -> 401 fail-closed', async () => {
  globalThis.__CF_KVS_STATE__ = { throw: true };
  const r = await handler(reqWith(EXPECTED));
  assert.equal(r.statusCode, 401);
});

test('key unset -> 401 fail-closed', async () => {
  globalThis.__CF_KVS_STATE__ = {};
  const r = await handler(reqWith(EXPECTED));
  assert.equal(r.statusCode, 401);
});

test('exact match -> pass through (returns the request object)', async () => {
  const ev = reqWith(EXPECTED);
  const r = await handler(ev);
  assert.equal(r, ev.request);
});
```

- [ ] **Step 2: Run the test to verify it fails (no implementation yet)**

Run (from the repo root):
```bash
node --import ./infra/modules/frontend-hosting/functions/__tests__/cloudfront-test-loader.mjs \
  --test infra/modules/frontend-hosting/functions/__tests__/basic-auth.test.mjs
```
Expected: FAIL — the top-level `await import('../basic-auth.js')` throws `ERR_MODULE_NOT_FOUND` (`Cannot find module '.../functions/basic-auth.js'`), so the test file fails to load.

- [ ] **Step 3: Write the deployed CloudFront Function (minimal, fail-closed)**

`infra/modules/frontend-hosting/functions/basic-auth.js`:

```js
import cf from 'cloudfront';

const kvs = cf.kvs();

async function handler(event) {
  const req = event.request;
  const sent = req.headers.authorization && req.headers.authorization.value;
  let expected;
  try {
    expected = await kvs.get('staging-basic-auth');
  } catch (e) {
    expected = null;
  }
  if (sent && expected && sent === expected) {
    return req;
  }
  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: { 'www-authenticate': { value: 'Basic realm="Mythrun staging"' } },
  };
}
```

(No `export` — intentional. The runtime invokes the global `handler`; the test gets it via the load hook.)

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
node --import ./infra/modules/frontend-hosting/functions/__tests__/cloudfront-test-loader.mjs \
  --test infra/modules/frontend-hosting/functions/__tests__/basic-auth.test.mjs
```
Expected: PASS — `ℹ pass 5  ℹ fail 0`.

- [ ] **Step 5: Confirm the deployed artifact has zero exports**

Run:
```bash
grep -c "export" infra/modules/frontend-hosting/functions/basic-auth.js
```
Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add infra/modules/frontend-hosting/functions/
git commit -m "feat(MYT-96): Basic-Auth CloudFront Function + fail-closed unit test"
```

---

### Task 2: Terraform module `infra/modules/frontend-hosting/`

**Files:**
- Create: `infra/modules/frontend-hosting/variables.tf`
- Create: `infra/modules/frontend-hosting/main.tf`
- Create: `infra/modules/frontend-hosting/outputs.tf`
- Consumes (already on disk from T1): `infra/modules/frontend-hosting/functions/basic-auth.js`

**Interfaces:**
- Consumes: `functions/basic-auth.js` via `file("${path.module}/functions/basic-auth.js")`.
- Produces (outputs, consumed by T3):
  - `bucket_name` (string) = `aws_s3_bucket.site.id`
  - `distribution_id` (string) = `aws_cloudfront_distribution.site.id`
  - `distribution_arn` (string) = `aws_cloudfront_distribution.site.arn`
  - `url` (string) = `"https://${var.site_domain}"`
  - `kvs_arn` (string|null) = `aws_cloudfront_key_value_store.basic_auth[0].arn` when `enable_basic_auth`, else `null`.
- Inputs (set by T3): `site_domain` (FQDN string), `acm_certificate_arn` (string), `hosted_zone_id` (string), `environment` (`"staging"|"production"`), `enable_basic_auth` (bool, default `true`).

> The module is kept as **one task**: the bucket policy references the distribution ARN and the distribution references the bucket's regional domain name, so an intermediate "bucket-only" split would not `terraform validate` as a coherent unit. The single reviewable deliverable is "the module validates."

- [ ] **Step 1: Write `variables.tf`**

`infra/modules/frontend-hosting/variables.tf`:

```hcl
variable "site_domain" {
  description = "FQDN the SPA is served at, e.g. 'staging.mythrun.com' (later 'mythrun.com'). Drives the CloudFront alias, the Route 53 record name, and the url output. FQDN — not subdomain+domain — so the prod apex is expressible."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.site_domain))
    error_message = "site_domain must be a bare FQDN with no scheme or path, e.g. 'staging.mythrun.com'."
  }
}

variable "acm_certificate_arn" {
  description = "ARN of the us-east-1 ACM cert covering site_domain. Reuse the shared *.mythrun.com wildcard cert — CloudFront requires us-east-1, which the whole stack already is."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID for mythrun.com (the shared workspace's dns_zone_id). The A-alias record for site_domain is created here."
  type        = string
}

variable "environment" {
  description = "Logical environment label ('staging' or 'production'). Used for resource naming + tags only."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "enable_basic_auth" {
  description = "When true (default), provision the CloudFront Function + KeyValueStore + viewer-request association that gate the site behind HTTP Basic-Auth. Flip to false at launch to make the site public (the app's own JWT auth remains)."
  type        = bool
  default     = true
}
```

- [ ] **Step 2: Write `main.tf`**

`infra/modules/frontend-hosting/main.tf`:

```hcl
# ======== Naming + constants ========
locals {
  bucket_name = "mythrun-${var.environment}-frontend"

  # Fixed KVS key the deployed function reads. A static cloudfront-js function
  # can't honor a per-call input, so this is a module constant, not a variable.
  kvs_key = "staging-basic-auth"
}

# ======== Managed cache policy ========
# AWS-managed CachingOptimized. Does NOT forward Authorization to the cache key
# or the origin — load-bearing for OAC: forwarding Authorization breaks SigV4
# origin signing. Do NOT attach an origin-request policy that forwards it.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# ======== Private S3 bucket (SPA artifact store) ========
resource "aws_s3_bucket" "site" {
  bucket = local.bucket_name

  tags = { Name = local.bucket_name }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ======== Origin Access Control ========
# signing_behavior = "always" overrides the viewer's Authorization: Basic header
# with CloudFront SigV4 on the origin request — so the Basic header never reaches
# S3 and origin signing works.
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "mythrun-${var.environment}-frontend-oac"
  description                       = "OAC for ${var.site_domain} SPA bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ======== Basic-Auth gate (count-toggled on enable_basic_auth) ========
# KVS created EMPTY by Terraform. The expected 'Basic <base64(user:pass)>'
# header is set out-of-band via the AWS CLI (see the staging runbook) — never
# in git or TF state.
resource "aws_cloudfront_key_value_store" "basic_auth" {
  count = var.enable_basic_auth ? 1 : 0

  name    = "mythrun-${var.environment}-frontend-basic-auth"
  comment = "Holds the '${local.kvs_key}' expected Basic-Auth header for ${var.site_domain}. Value set out-of-band via the AWS CLI."
}

resource "aws_cloudfront_function" "basic_auth" {
  count = var.enable_basic_auth ? 1 : 0

  name    = "mythrun-${var.environment}-frontend-basic-auth"
  runtime = "cloudfront-js-2.0"
  comment = "Viewer-request HTTP Basic-Auth gate for ${var.site_domain}. Fails closed to 401 in every branch."
  publish = true
  code    = file("${path.module}/functions/basic-auth.js")

  key_value_store_associations = [aws_cloudfront_key_value_store.basic_auth[0].arn]
}

# ======== CloudFront distribution ========
resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Mythrun ${var.environment} frontend (${var.site_domain})"
  aliases             = [var.site_domain]
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    origin_id                = "s3-${aws_s3_bucket.site.id}"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-${aws_s3_bucket.site.id}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id

    # MODULE INVARIANT: if ordered cache behaviors are ever added, each must
    # carry the same viewer-request association, or it is a gate bypass path.
    dynamic "function_association" {
      for_each = var.enable_basic_auth ? [1] : []
      content {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.basic_auth[0].arn
      }
    }
  }

  # SPA fallback. The 403 mapping is load-bearing: a private OAC bucket
  # (GetObject only, no ListBucket) returns 403 — not 404 — for missing
  # deep-link keys. The Basic-Auth 401 is emitted by the function BEFORE the
  # origin, so it is unaffected by these origin-error rules.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = { Name = "mythrun-${var.environment}-frontend" }
}

# ======== Bucket policy — GetObject only, to CloudFront via OAC ========
data "aws_iam_policy_document" "site_bucket" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site_bucket.json
}

# ======== Route 53 A-alias ========
# CloudFront's hosted zone id is the fixed global constant Z2FDTNDATAQYW2.
resource "aws_route53_record" "site" {
  zone_id = var.hosted_zone_id
  name    = var.site_domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}
```

- [ ] **Step 3: Write `outputs.tf`**

`infra/modules/frontend-hosting/outputs.tf`:

```hcl
output "bucket_name" {
  value       = aws_s3_bucket.site.id
  description = "Name of the private SPA artifact bucket (set as GitHub Actions var STAGING_FRONTEND_BUCKET)."
}

output "distribution_id" {
  value       = aws_cloudfront_distribution.site.id
  description = "CloudFront distribution ID (set as GitHub Actions var STAGING_FRONTEND_DISTRIBUTION_ID; used for create-invalidation)."
}

output "distribution_arn" {
  value       = aws_cloudfront_distribution.site.arn
  description = "CloudFront distribution ARN (consumed by the OIDC role's cloudfront:CreateInvalidation grant)."
}

output "url" {
  value       = "https://${var.site_domain}"
  description = "Public URL of the gated SPA."
}

output "kvs_arn" {
  value       = var.enable_basic_auth ? aws_cloudfront_key_value_store.basic_auth[0].arn : null
  description = "ARN of the Basic-Auth KeyValueStore — used by the out-of-band put-key password set/rotate. Null when enable_basic_auth = false."
}
```

- [ ] **Step 4: Format-check the module**

Run:
```bash
cd infra/modules/frontend-hosting && terraform fmt -check -recursive
```
Expected: no output, exit 0. (If it reports files, run `terraform fmt -recursive` and re-check.)

- [ ] **Step 5: Init (no backend) + validate**

Run:
```bash
cd infra/modules/frontend-hosting && terraform init -backend=false && terraform validate
```
Expected: `Terraform has been successfully initialized!` then `Success! The configuration is valid.` Terraform infers `hashicorp/aws` for the `aws_*` resources (a benign provider-inference note may print); the authoritative provider-pinned validate happens in Task 3.

- [ ] **Step 6: Commit**

```bash
git add infra/modules/frontend-hosting/variables.tf infra/modules/frontend-hosting/main.tf infra/modules/frontend-hosting/outputs.tf
git commit -m "feat(MYT-96): reusable frontend-hosting module (private S3 + CloudFront OAC + Basic-Auth gate)"
```

---

### Task 3: Staging wiring (IAM + module block + outputs)

**Files:**
- Modify: `infra/environments/staging/main.tf` (extend `data.aws_iam_policy_document.gh_actions_staging`, ~lines 507-676; add a `module "frontend_hosting"` block)
- Modify: `infra/environments/staging/outputs.tf` (append 4 outputs)

**Interfaces:**
- Consumes: T2 module outputs `bucket_name`, `distribution_arn`, `distribution_id`, `url`, `kvs_arn`; the already-exported `data.terraform_remote_state.shared.outputs.wildcard_cert_arn` and `.dns_zone_id`.
- Produces (staging outputs, consumed by T5 bring-up): `frontend_bucket_name`, `frontend_distribution_id`, `frontend_url`, `frontend_kvs_arn`. Grants the existing `mythrun-github-actions-staging` role resource-scoped S3 + CloudFront-invalidation on the new bucket/distribution.

- [ ] **Step 1: Add the `module "frontend_hosting"` block**

In `infra/environments/staging/main.tf`, after the `module "bootstrap_db"` block (ends ~line 203) and before the `# ======== Smoke Prep-Pipeline Task Family` section, insert:

```hcl
# ======== Frontend Hosting Module (MYT-96) ========
# Private S3 + CloudFront at staging.mythrun.com behind a Basic-Auth CloudFront
# Function. Reuses the shared *.mythrun.com wildcard cert + dns_zone_id (both
# already exported by shared/outputs.tf) — no new cert, no new shared outputs.
# Environment-parameterized: production reuses this module at Launch with the
# apex domain and enable_basic_auth = false.
module "frontend_hosting" {
  source = "../../modules/frontend-hosting"

  environment         = var.environment
  site_domain         = "staging.mythrun.com"
  acm_certificate_arn = data.terraform_remote_state.shared.outputs.wildcard_cert_arn
  hosted_zone_id      = data.terraform_remote_state.shared.outputs.dns_zone_id
  enable_basic_auth   = true
}
```

- [ ] **Step 2: Extend the `gh_actions_staging` IAM policy document with two resource-scoped statements**

In `infra/environments/staging/main.tf`, inside `data "aws_iam_policy_document" "gh_actions_staging"`, immediately after the `# ECR describe-images for resolving the SHA-pinned digest` statement (the one ending with `repository/mythrun"` ... `]` ... `}` around line 671) and before the closing `}` of the data block (line 676), insert:

```hcl
  # MYT-96: frontend deploy — additive S3 sync + index.html cp + trailing prune
  # to the SPA bucket. Resource-scoped to the new bucket (ListBucket on the
  # bucket arn; object actions on /*). S3 ARNs are partition-global, so
  # constructing from bucket_name is exact — no new module output needed.
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::${module.frontend_hosting.bucket_name}",
      "arn:aws:s3:::${module.frontend_hosting.bucket_name}/*",
    ]
  }

  # MYT-96: CloudFront /index.html invalidation after each deploy.
  # Resource-scoped to the new distribution.
  statement {
    actions = [
      "cloudfront:CreateInvalidation",
      "cloudfront:GetInvalidation",
    ]
    resources = [module.frontend_hosting.distribution_arn]
  }
```

- [ ] **Step 3: Add the staging outputs**

Append to `infra/environments/staging/outputs.tf`:

```hcl
# ======== MYT-96 frontend-hosting outputs ========

output "frontend_bucket_name" {
  value       = module.frontend_hosting.bucket_name
  description = "SPA artifact bucket. Set as GitHub Actions var STAGING_FRONTEND_BUCKET (see MYT-96 §5 bring-up)."
}

output "frontend_distribution_id" {
  value       = module.frontend_hosting.distribution_id
  description = "CloudFront distribution ID. Set as GitHub Actions var STAGING_FRONTEND_DISTRIBUTION_ID."
}

output "frontend_url" {
  value       = module.frontend_hosting.url
  description = "Public URL of the gated staging SPA (https://staging.mythrun.com)."
}

output "frontend_kvs_arn" {
  value       = module.frontend_hosting.kvs_arn
  description = "Basic-Auth KeyValueStore ARN — used by the out-of-band put-key password set/rotate (see MYT-96 §5). Null when the gate is disabled."
}
```

- [ ] **Step 4: Format-check the staging workspace**

Run:
```bash
cd infra/environments/staging && terraform fmt -check
```
Expected: no output, exit 0.

- [ ] **Step 5: Init (no backend) + validate against the pinned provider**

Run:
```bash
cd infra/environments/staging && terraform init -backend=false && terraform validate
```
Expected: `Success! The configuration is valid.` (This run uses the workspace's `hashicorp/aws ~> 6.0` pin + the configured `provider "aws"`, so it authoritatively validates the new module's resource schemas. `-backend=false` skips the S3 backend so no AWS creds are needed.)

- [ ] **Step 6: Commit**

```bash
git add infra/environments/staging/main.tf infra/environments/staging/outputs.tf
git commit -m "feat(MYT-96): wire frontend-hosting into staging + resource-scoped OIDC S3/CloudFront grants"
```

---

### Task 4: Deploy workflow `.github/workflows/deploy-frontend.yml`

**Files:**
- Create: `.github/workflows/deploy-frontend.yml`

**Interfaces:**
- Consumes: GitHub Actions Environment-`staging` variables `vars.AWS_ACCOUNT_ID` (already set), `vars.STAGING_FRONTEND_BUCKET` + `vars.STAGING_FRONTEND_DISTRIBUTION_ID` (set in T5 from `terraform output`); the existing OIDC role `mythrun-github-actions-staging`; the T3 IAM grants; `frontend/dist/` produced by `pnpm --filter @mythrun/web build`.
- Produces: a live deploy — additive S3 upload + `/index.html` invalidation + a smoke that asserts `401` (gate live). No new repo interface for later tasks.

- [ ] **Step 1: Write the workflow**

`.github/workflows/deploy-frontend.yml`:

```yaml
name: Deploy Frontend

on:
  push:
    branches: [main]
    paths:
      - 'frontend/**'
      - '.github/workflows/deploy-frontend.yml'
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  # Separate group from the backend api/worker/smoke deploys: a frontend deploy
  # must not queue behind (or be cancelled by) a backend roll, and two
  # near-simultaneous main pushes must not interleave the bucket sync.
  group: deploy-mythrun-staging-frontend
  cancel-in-progress: false

env:
  AWS_REGION: us-east-1
  SITE_URL: https://staging.mythrun.com

jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: staging
    steps:
      - name: Pre-flight — verify required vars are set
        run: |
          if [[ -z "${{ vars.AWS_ACCOUNT_ID }}" ]]; then
            echo "::error::vars.AWS_ACCOUNT_ID is not set. Configure at Settings → Environments → staging → Environment variables."
            exit 1
          fi
          if [[ -z "${{ vars.STAGING_FRONTEND_BUCKET }}" ]]; then
            echo "::error::vars.STAGING_FRONTEND_BUCKET is not set. Run 'terraform output -raw frontend_bucket_name' and set it at Settings → Environments → staging → Environment variables (see MYT-96 §5 bring-up order)."
            exit 1
          fi
          if [[ -z "${{ vars.STAGING_FRONTEND_DISTRIBUTION_ID }}" ]]; then
            echo "::error::vars.STAGING_FRONTEND_DISTRIBUTION_ID is not set. Run 'terraform output -raw frontend_distribution_id' and set it at Settings → Environments → staging → Environment variables."
            exit 1
          fi

      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - uses: pnpm/action-setup@903f9c1a6ebcba6cf41d87230be49611ac97822e # v6.0.3

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      # Scope install to the web app + its transitive workspace deps (same
      # filter set as frontend-check.yml). --frozen-lockfile validates the
      # full lockfile.
      - run: pnpm install --frozen-lockfile --filter @mythrun/web... --filter @mythrun/ui... --filter @mythrun/client-core... --filter @mythrun/contract...

      # @mythrun/contract — the shared Zod wire contract, the only frontend
      # package that ships compiled output (NodeNext dist, gitignored).
      # @mythrun/web reaches it transitively (client-core/src/api/*.ts import the
      # Zod schemas from @mythrun/contract/rest), so a fresh runner fails to
      # resolve it without this. (Exactly what frontend-check.yml does.)
      - run: pnpm --filter @mythrun/contract build

      # No shortcuts on deploy: vite build strips types and runs no tests, so
      # the deploy verifies before it ships. frontend-check is a separate
      # workflow that does NOT gate this one (we push directly to main).
      - run: pnpm --filter @mythrun/web typecheck
      - run: pnpm --filter @mythrun/web test

      # Production build → JWT auth seam (import.meta.env.PROD). Vite reads
      # VITE_-prefixed env at build time; point the SPA at the staging API
      # origin (cross-origin; CORS already allows it).
      - run: pnpm --filter @mythrun/web build
        env:
          VITE_API_BASE_URL: https://staging-api.mythrun.com

      - name: Assume AWS role via OIDC
        # Load-bearing: pnpm install above runs BEFORE OIDC assume so npm
        # lifecycle scripts cannot exfiltrate AWS creds (mirrors deploy.yml).
        uses: aws-actions/configure-aws-credentials@d979d5b3a71173a29b74b5b88418bfda9437d885 # v6.1.1
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Upload assets (additive) + index.html (no-cache) + invalidate
        env:
          BUCKET: ${{ vars.STAGING_FRONTEND_BUCKET }}
          DIST: ${{ vars.STAGING_FRONTEND_DISTRIBUTION_ID }}
        run: |
          set -euo pipefail
          # Additive — no --delete in the hot path, so the new index never
          # references a not-yet-uploaded or just-deleted asset. dist/ is
          # index.html + content-hashed assets/, so blanket-immutable is safe.
          aws s3 sync frontend/dist/ "s3://$BUCKET/" --exclude index.html \
            --cache-control "public,max-age=31536000,immutable"
          # index.html is the mutable entry point — never cache it.
          aws s3 cp frontend/dist/index.html "s3://$BUCKET/index.html" \
            --cache-control "no-cache" --content-type "text/html"
          # Under CachingOptimized (minTTL 1s) the invalidation is the
          # load-bearing guarantee that the new deploy is picked up.
          aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html"

      - name: Prune stale hashed assets (out of the hot path)
        env:
          BUCKET: ${{ vars.STAGING_FRONTEND_BUCKET }}
        run: |
          set -euo pipefail
          # Runs AFTER the additive upload + invalidation, so the new index is
          # already live and edge-cached old chunks survive their max-age.
          # --exclude index.html keeps the no-cache index intact (a plain
          # --delete sync would otherwise re-PUT it with the immutable header).
          aws s3 sync frontend/dist/ "s3://$BUCKET/" --delete --exclude index.html \
            --cache-control "public,max-age=31536000,immutable"

      - name: Smoke test (distribution live + gate on → 401)
        run: |
          set -euo pipefail
          attempts=5
          for attempt in $(seq 1 "$attempts"); do
            echo "Smoke test attempt $attempt of $attempts..."
            CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${SITE_URL}/" || echo "000")
            echo "HTTP $CODE"
            # 401 proves the distribution resolves AND the Basic-Auth gate is on.
            # Secret-free: a 401 also matches "password never set" — the aws s3
            # step succeeding is the real upload guard (MYT-96 §4.3).
            if [[ "$CODE" == "401" ]]; then
              echo "Smoke passed."
              exit 0
            fi
            if [[ "$attempt" -lt "$attempts" ]]; then
              sleep 15
            fi
          done
          echo "::error::Smoke did not observe 401 after $attempts attempts (CloudFront/Route53 propagation, or the gate is off)."
          exit 1
```

- [ ] **Step 2: Verify the YAML parses**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy-frontend.yml')); print('YAML OK')"
```
Expected: `YAML OK`.

- [ ] **Step 3: Verify SHAs + conventions match `deploy.yml`**

Run:
```bash
grep -E "actions/checkout@de0fac|pnpm/action-setup@903f|actions/setup-node@48b55|configure-aws-credentials@d979d5b" .github/workflows/deploy-frontend.yml | wc -l
grep -c "role/mythrun-github-actions-staging" .github/workflows/deploy-frontend.yml
grep -c "deploy-mythrun-staging-frontend" .github/workflows/deploy-frontend.yml
```
Expected: `4` (all four pinned SHAs present), `1` (OIDC role), `1` (concurrency group).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-frontend.yml
git commit -m "ci(MYT-96): frontend staging deploy workflow (OIDC, contract pre-build, additive S3 sync + invalidate, 401 smoke)"
```

---

### Task 5: Integration & first bring-up — CONTROLLER-DRIVEN CLOSE GATE (not a code subagent task)

> **This task is the human-supervised close gate, not autonomous implementation.** It applies real Terraform, sets GitHub + KVS secrets, and triggers the first real deploy. The controller drives it (steps need AWS creds + `gh` auth + the chosen password). It is the "gated on a real green run before close" step — do not mark MYT-96 done until `curl` returns 401 without creds and 200 with the password.

**Files:** none (operational).

**Interfaces:**
- Consumes: T2/T3 Terraform (`module.frontend_hosting` + staging outputs), T4 workflow, the chosen staging password (Miklos's call).
- Produces: live `https://staging.mythrun.com` behind the gate, serving the built SPA pointed at `staging-api.mythrun.com`; the two GitHub Actions vars set; the KVS password set.

- [ ] **Step 1: Apply the Terraform (full provider init + plan + apply)**

Run:
```bash
cd infra/environments/staging
terraform fmt -check
terraform init
terraform plan -out=frontend.tfplan   # review: new bucket, distribution, OAC, KVS, function, Route53 A-alias, 2 IAM statements
terraform apply frontend.tfplan
```
Expected: apply completes; new resources include `module.frontend_hosting.aws_cloudfront_distribution.site`, `aws_s3_bucket.site`, `aws_cloudfront_function.basic_auth[0]`, `aws_cloudfront_key_value_store.basic_auth[0]`, `aws_route53_record.site`. (CloudFront create can take several minutes.)

- [ ] **Step 2: Set the two GitHub Actions environment variables from outputs**

Run:
```bash
cd infra/environments/staging
gh variable set STAGING_FRONTEND_BUCKET --env staging --body "$(terraform output -raw frontend_bucket_name)"
gh variable set STAGING_FRONTEND_DISTRIBUTION_ID --env staging --body "$(terraform output -raw frontend_distribution_id)"
gh variable list --env staging | grep STAGING_FRONTEND
```
Expected: both `STAGING_FRONTEND_BUCKET` and `STAGING_FRONTEND_DISTRIBUTION_ID` listed.

- [ ] **Step 3: Set the Basic-Auth password in the KVS (out-of-band; never committed)**

Run (substitute the chosen password — ask Miklos):
```bash
cd infra/environments/staging
KVS_ARN=$(terraform output -raw frontend_kvs_arn)
CRED="Basic $(printf 'mythrun:<chosen-password>' | base64 | tr -d '\n')"   # tr strips base64's 76-col wrap
ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn "$KVS_ARN" --query ETag --output text)
aws cloudfront-keyvaluestore put-key --kvs-arn "$KVS_ARN" \
  --key staging-basic-auth --value "$CRED" --if-match "$ETAG"
```
Expected: `put-key` returns the new ETag. Takes effect within ~a minute (KVS propagation).

- [ ] **Step 4: Trigger the first deploy (workflow_dispatch from `main`)**

Run:
```bash
gh workflow run deploy-frontend.yml --ref main
gh run watch "$(gh run list --workflow=deploy-frontend.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: the run goes green; the smoke step prints `HTTP 401` then `Smoke passed.`

- [ ] **Step 5: E2E verify from the laptop (the real "done when")**

Run:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://staging.mythrun.com/            # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -u 'mythrun:<chosen-password>' https://staging.mythrun.com/   # expect 200
curl -s -u 'mythrun:<chosen-password>' https://staging.mythrun.com/ | grep -o '<title>[^<]*</title>'   # expect the SPA title
```
Expected: `401` without creds; `200` with creds; the SPA HTML title in the third call. Confirm in a browser that the app loads and that authed routes redirect to sign-in (prod JWT seam, expected until MYT-84).

- [ ] **Step 6: Close the loop (per CLAUDE.md close protocol)**

- Dispatch the `docs/wiki/AUTHORING.md` wiki-update subagent for MYT-96 (it updates `docs/wiki/` + commits locally).
- `git push` (code commits + wiki commit in one push).
- Flip the Linear issue MYT-96 to Done.

---

## Self-Review

**1. Spec coverage** (each spec section → task):

- §2 / §3.1 / §4.2 gate (CloudFront Function + KVS, fail-closed, runtime `cloudfront-js-2.0`, KVS key `staging-basic-auth`, no secret in source) → **T1** (function + test) + **T2** (`aws_cloudfront_function` + `aws_cloudfront_key_value_store`, `count`-toggled).
- §4.1 module (private S3 + PAB, OAC `signing_behavior="always"`, distribution with alias/cert/PriceClass_100/HTTP→HTTPS/compress/default-root, 403&404 SPA fallback, `CachingOptimized`, regional REST endpoint, Route 53 alias, inputs/outputs) → **T2**.
- §3.2 realistic-JWT posture → **T4** prod `vite build` + `VITE_API_BASE_URL` (no dev-bypass flag); no code change needed (the app's DEV/PROD seam already does this — `main.tsx`).
- §3.3 URL/cert/zone reuse, FQDN `site_domain`, separate workflow → **T2** (`site_domain` input) + **T3** (wildcard cert + dns_zone_id reuse) + **T4** (separate `deploy-frontend.yml`).
- §4.3 deploy workflow (trigger paths + dispatch, concurrency, pre-flight guard, scoped install, contract build, typecheck+test, build w/ env, OIDC, additive sync + cp + invalidate, prune, 401 smoke) → **T4**.
- §4.4 IAM (two resource-scoped statements, no new role, no PassRole) + composition (`module` block + staging outputs) → **T3**.
- §5 runbooks (bring-up order, password set/rotate, manual deploy, gate removal) → **T5** (executed) + `enable_basic_auth` toggle in **T2** (gate removal = one-line tfvars flip).
- §6 done-when (serves SPA behind gate, reachable with password, points at staging-api, auto-redeploys, fresh-runner clean build, no broken-asset window) → **T4** + **T5**.
- §7 constraints → **Global Constraints** section above + enforced per task.

No spec requirement is left without a task. (Gate-removal-at-launch and production reuse are deferred per §6 but the mechanism — `enable_basic_auth` + `site_domain` — is built in T2.)

**2. Placeholder scan:** No `TBD` / `TODO` / "add error handling" / "similar to Task N" / bare "write tests". Every code step carries complete HCL / JS / YAML. The only intentional `<chosen-password>` placeholders are in T5, the human-supervised step where Miklos supplies the secret out-of-band (never committed).

**3. Type / name consistency:**
- KVS key constant `staging-basic-auth` — identical in T1 (`kvs.get('staging-basic-auth')`), T2 (`local.kvs_key`), T5 (`--key staging-basic-auth`). ✓
- Module outputs `bucket_name` / `distribution_id` / `distribution_arn` / `url` / `kvs_arn` (T2) match the consumers in T3 (`module.frontend_hosting.bucket_name`, `.distribution_arn`) and the staging outputs (`frontend_*`). ✓
- GitHub vars `STAGING_FRONTEND_BUCKET` / `STAGING_FRONTEND_DISTRIBUTION_ID` — identical across T4 (pre-flight + upload) and T5 (`gh variable set`). ✓
- `handler` signature (T1 produces module-global `handler`; T2 reads the file) and the export-free invariant (T1 Step 5 asserts `grep -c export == 0`). ✓
- Pinned SHAs identical to `deploy.yml` / `frontend-check.yml` (T4 Step 3 asserts count 4). ✓
