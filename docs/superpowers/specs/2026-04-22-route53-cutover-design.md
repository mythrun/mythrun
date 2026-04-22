# MYT-26: Route 53 Cutover for `mythrun.com` — Design Spec

**Goal:** Move authoritative DNS for `mythrun.com` from Squarespace Domains to a Route 53 hosted zone without breaking Google Workspace email, and pre-provision a DNS-validated wildcard ACM certificate that MYT-30 attaches to the staging ALB.

**Linear issue:** MYT-26
**Status:** Approved, ready to plan
**Author:** Miklos + Claude Opus 4.7
**Date:** 2026-04-22

---

## Scope

**In scope (MYT-26):**

1. New Route 53 public hosted zone for `mythrun.com`
2. Nine email records, replicated exactly from the Squarespace audit (5 MX + 4 TXT)
3. One wildcard ACM certificate — `*.mythrun.com` with `mythrun.com` as a SAN — DNS-validated against the new zone
4. Outputs exposed to other workspaces via `terraform_remote_state`: `dns_zone_id`, `dns_zone_name`, `name_servers`, `wildcard_cert_arn`
5. Human-action cutover procedure + verification + rollback
6. Linear close-out comment making MYT-26's deliverables explicit for the MYT-30 agent

**Out of scope:**

- `staging-api.mythrun.com` A-alias record → lives in MYT-30 (pointers at the ALB created there)
- `api.mythrun.com` A-alias record → lives in production workspace, future milestone
- Apex + `www` records → deferred to Frontend milestone (2026-05-24) when CloudFront lands
- Any DNSSEC configuration — Route 53's default "no DNSSEC" is fine for launch
- MX/TXT automation via `aws ses` / `aws workmail` — not applicable, we use Google Workspace
- Route 53 Resolver / private hosted zones — VPC DNS is covered by MYT-25's `enable_dns_support`

## Record inventory

The canonical audit with every verbatim value lives in the Linear MYT-26 comment (updated 2026-04-22). For the record, the values below are the full set that Terraform must create. Values are reproduced here because Linear comments are mutable; a git-committed spec is the durable source.

### Email records — preserve exactly (9 records)

**5 MX records at apex, all with TTL 300 in Route 53:**

| Priority | Target |
|---------:|--------|
| 1  | `aspmx.l.google.com.` |
| 5  | `alt1.aspmx.l.google.com.` |
| 5  | `alt2.aspmx.l.google.com.` |
| 10 | `alt3.aspmx.l.google.com.` |
| 10 | `alt4.aspmx.l.google.com.` |

All five MX records share a single `aws_route53_record` resource (multi-value records collapse into one resource, five `records` entries, one RRTYPE). Route 53 returns all of them in every response; resolver picks by priority.

**4 TXT records:**

| Name | TTL | Value |
|------|----:|-------|
| apex | 300 | `v=spf1 include:_spf.google.com ~all` |
| apex | 300 | `google-site-verification=wFPzLNmQdEDr4YIbu6EdooFMeEpUvEtOTt2OX7QlYs0` |
| `_dmarc` | 300 | `v=DMARC1; p=quarantine; rua=mailto:dev@mythrun.com` |
| `google._domainkey` | 300 | `v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmahZYAC+S0RRJLvVmIx2Pp2P73HT30vgVxskC0hqpqCQlCAAoubNMlMzOC3QJnIlZ2fYEoqV9k0G9pjev/6tlMsVAyvrhBC+dNdRhkPRpDm9v5dXhdghoB9NlNNTb4R0Rb5r8UUyG3xckDZoEut6AaopWhce5qyXZN98FCwJPqrHkJRhnfIza8PfNwEJKw7tx43dRGpdYWumsPNFGl8O0+HixtMDbzjo4Eg0GetYIdIqD7heXV7I4cD1TVj/9X4zGiBSh8U55vgwMGwu+7ZowO3lbm9fA7+E7dCsRaIC7sNJMdkn4NzzuKEBaJb9TkO/EGFMzcWXoxbYhcckE5eJMQIDAQAB` |

**TTL decision: 300s on every record.** The Squarespace values range 1800–14400s. We drop them all to 300 because (a) we never change these records so the low TTL doesn't cost us cache hits, and (b) any mistake that needs fixing propagates to resolvers in 5 minutes instead of 4 hours. Route 53 NS/SOA records use provider defaults (172800s); we don't override those.

**Apex TXT collapse:** Terraform models two distinct TXT records at the apex (SPF + Google verification) as a single `aws_route53_record` with two `records` entries. DNS requires that all TXT records at the same name live in a single RRSET.

### Squarespace website records — drop at cutover (7 records, NOT created in Route 53)

These records exist in Squarespace today and serve the "under construction" placeholder page. They are not replicated:

- 4 apex A records (the four Squarespace anycast IPs)
- `www` CNAME to `ext-sq.squarespace.com`
- HTTPS SvcB record at apex
- `_domainconnect` CNAME

After NS cutover, apex + `www` return NXDOMAIN until the Frontend milestone wires CloudFront. Agreed with Miklos: the placeholder page is not load-bearing.

## Architecture

### Terraform layout

```
infra/
  modules/
    dns/              NEW
      main.tf         aws_route53_zone, 9 email records, aws_acm_certificate,
                      cert-validation CNAMEs, aws_acm_certificate_validation waiter
      variables.tf    domain_name (string), dkim_key_rrdata (string, no default)
      outputs.tf      zone_id, zone_name, name_servers, wildcard_cert_arn
  environments/
    shared/
      main.tf         (existing) network + data; appends module "dns"
      outputs.tf      (existing + new)
```

### Why `environments/shared/` owns this

Both `staging/` and future `production/` will point subdomains at the same `mythrun.com` zone. The wildcard cert is cross-env too (staging ALB uses `*.mythrun.com` cert; prod ALB uses the same cert for `api.mythrun.com`). Same pattern as `modules/network/` and `modules/data/` — cross-env resources live in `shared/`.

### Cross-workspace handoff

MYT-30's staging workspace reads from shared state:

```hcl
data "terraform_remote_state" "shared" {
  backend = "s3"
  config  = { bucket = "mythrun-terraform-state", key = "environments/shared/terraform.tfstate", region = "us-east-1" }
}

resource "aws_route53_record" "staging_api" {
  zone_id = data.terraform_remote_state.shared.outputs.dns_zone_id
  name    = "staging-api.${data.terraform_remote_state.shared.outputs.dns_zone_name}"
  # ... alias target = staging ALB
}

resource "aws_lb_listener" "https" {
  certificate_arn = data.terraform_remote_state.shared.outputs.wildcard_cert_arn
  # ...
}
```

MYT-26 must expose exactly these four outputs. The MYT-30 agent reads them — no coordination needed beyond the output contract.

### DKIM key handling

DKIM public keys are published to DNS for the world to see — they are not secrets. The full 256-char RSA body is committed verbatim to `infra/modules/dns/main.tf` as a string literal. No environment-variable ceremony, no Vault, no separate secrets file. The spec already has the full value embedded above; the Terraform module inlines the same string.

### ACM wildcard certificate

```hcl
resource "aws_acm_certificate" "wildcard" {
  domain_name               = "mythrun.com"
  subject_alternative_names = ["*.mythrun.com"]
  validation_method         = "DNS"

  lifecycle { create_before_destroy = true }

  tags = { Name = "mythrun-wildcard" }
}
```

Cert covers `mythrun.com` (apex) + any single-label subdomain (`staging-api`, `api`, `www`). Does NOT cover two-label subdomains like `foo.staging-api.mythrun.com` — if we ever need that, we add it as an explicit SAN. Not a launch concern.

**Region:** cert is created in us-east-1. CloudFront requires us-east-1 certs specifically, so the future apex/www ALIAS-to-CloudFront path works. ALB certs in us-east-1 also work. One cert, one region, serves both.

**Validation records** use `for_each` over `aws_acm_certificate.wildcard.domain_validation_options`, creating one `aws_route53_record` per domain (apex + wildcard = 2 records, but ACM deduplicates identical CNAME targets so typically only 1 validation CNAME actually lands).

**`aws_acm_certificate_validation` waiter** blocks until AWS reports the cert ISSUED. This waiter can stall for ~5-30 min pre-NS-cutover because the validation records only resolve once Route 53 is authoritative. Strategy: either (a) accept the wait on first apply (cert finishes validating in-flight once NS is cut over, assuming the apply process is still alive), or (b) split the apply into two — first pass leaves cert in `PENDING_VALIDATION`, cutover happens, second pass confirms `ISSUED`.

Decision: **split the apply.** Use a `-target` on the first apply that stops at cert creation (no validation waiter), then cut over NS, then do a final unrestricted apply that lets the validation waiter complete. Operationally cleaner than holding Terraform open across a human action.

Concrete sequence (expanded in "Cutover procedure" below):

1. `terraform apply -target=module.dns.aws_acm_certificate.wildcard -target=module.dns.aws_route53_zone.main -target=module.dns.aws_route53_record.email -target=module.dns.aws_route53_record.cert_validation`
   — creates zone + email records + cert (PENDING_VALIDATION) + validation CNAMEs, does NOT run the validation waiter
2. Verify email records resolve correctly against AWS NS directly
3. Miklos swaps NS at Squarespace
4. Propagation watch
5. `terraform apply` (unrestricted) — this is when `aws_acm_certificate_validation` runs; it sees the cert is already validated and returns immediately

## Cutover procedure

Human-action step is step 4 only; everything else Claude runs.

**Step 1 — Pre-flight:**

- Confirm `aws sts get-caller-identity` returns `mythrun-admin`.
- `terraform plan` in `environments/shared/` shows: 1 zone + 9 email records + 1 cert + N validation CNAMEs + 0 destroys. No changes to network or data modules (we're additive).
- Miklos confirms this is the right moment (email will be vulnerable for 5-60 min during propagation — pick a time when you're available to do the smoke test).

**Step 2 — Targeted apply (no validation waiter):**

```
cd infra/environments/shared
terraform apply \
  -target=module.dns.aws_route53_zone.main \
  -target=module.dns.aws_route53_record.email \
  -target=module.dns.aws_acm_certificate.wildcard \
  -target=module.dns.aws_route53_record.cert_validation
```

Apply output prints the 4 AWS nameservers assigned to the zone — capture these.

**Step 3 — Verify records against AWS NS directly (before touching Squarespace):**

For each of the 4 nameservers, run the email-record probes:

```bash
NS="ns-XXX.awsdns-XX.com"
dig @$NS +short MX mythrun.com                          # expect 5 MX with correct priorities
dig @$NS +short TXT mythrun.com                         # expect 2 TXTs: SPF + Google verification
dig @$NS +short TXT _dmarc.mythrun.com                  # expect DMARC policy
dig @$NS +short TXT google._domainkey.mythrun.com       # expect full DKIM key
```

**Gate: every record must match the audit exactly before proceeding.** If any mismatch: fix the Terraform, re-apply, re-verify. Do not continue.

**Step 4 — Miklos swaps nameservers at Squarespace Domains:**

1. Squarespace Domains → `mythrun.com` → DNS → Nameservers
2. Change from "Squarespace nameservers" to "Custom nameservers"
3. Enter the 4 AWS nameservers from step 2 output
4. Save

**Step 5 — Propagation watch (Claude, 5-60 min):**

```bash
# Loop until all four globally-distributed resolvers return AWS NS
for resolver in 1.1.1.1 8.8.8.8 9.9.9.9 208.67.222.222; do
  dig @$resolver +short NS mythrun.com
done
```

Exit when all four return AWS nameservers.

**Step 6 — Final apply (validation waiter runs):**

```
cd infra/environments/shared
terraform apply
```

The `aws_acm_certificate_validation.wildcard` waiter checks; cert is already ISSUED (the validation records have been resolvable since NS propagation); apply completes in seconds.

**Step 7 — Email smoke test (Miklos):**

- Send an email FROM `dev@mythrun.com` to a personal Gmail → check inbox, check SPF/DKIM/DMARC pass in raw headers.
- Send an email TO `dev@mythrun.com` from a personal Gmail → arrives.

**Step 8 — Outputs and handoff:**

Confirm `terraform output` on shared returns: `dns_zone_id`, `dns_zone_name`, `name_servers`, `wildcard_cert_arn`. Close MYT-26 in Linear with an explicit comment for the MYT-30 agent listing those four output names.

## Error handling / rollback

**Pre-apply failure:** Terraform validates locally, nothing touches AWS or Squarespace. Zero risk.

**Apply succeeds but a record is wrong:** caught in step 3 verification (against AWS NS directly, before Squarespace is touched). Fix Terraform → re-apply → re-verify. Email is still served by Squarespace throughout.

**Post-NS-swap email breaks:** rollback = point NS back to Squarespace at the registrar. Same 5-60 min re-propagation. Sending MTAs queue undelivered mail during the gap (typical retry windows are 24-48h, so nothing is lost permanently).

**ACM cert stuck in PENDING_VALIDATION after Step 6:** check that `aws_route53_record.cert_validation` actually created the CNAME, `dig` it against Route 53 directly, check AWS ACM console for the specific validation status. Does not affect email or user-facing DNS — cert is only needed by MYT-30's ALB.

**Squarespace refuses the NS change:** unlikely but possible. Confirm domain is unlocked for DNS changes. If registrar lock is on, Miklos disables it first.

## Testing

No runtime tests — this is DNS infrastructure. Verification is:

1. `terraform plan` after Step 6 reports "No changes" (idempotency gate).
2. `dig` commands in Step 3 and Step 5 produce expected results.
3. `aws acm describe-certificate --certificate-arn <arn>` → `Status: ISSUED` post-cutover.
4. Real email round-trip in Step 7.

## Acceptance criteria ("Done when")

From the Linear issue, translated to executable checks:

- [ ] `dig +short NS mythrun.com` returns four AWS nameservers (ns-XXX.awsdns-XX.com etc.).
- [ ] `dig +short MX mythrun.com` returns exactly the 5 Google MX hosts with correct priorities.
- [ ] `dig +short TXT _dmarc.mythrun.com` returns the DMARC policy verbatim.
- [ ] `dig +short TXT google._domainkey.mythrun.com` returns the full DKIM public key.
- [ ] `aws acm describe-certificate` reports `Status: ISSUED` for the wildcard cert.
- [ ] Email round-trip on `dev@mythrun.com` succeeds in both directions with SPF/DKIM/DMARC passing.
- [ ] `terraform plan` on shared reports "No changes" (idempotency).
- [ ] All four shared-workspace outputs (`dns_zone_id`, `dns_zone_name`, `name_servers`, `wildcard_cert_arn`) are populated and accessible via `terraform output`.
- [ ] MYT-26 is closed in Linear with a close-out comment explicitly listing the output names and ARNs for the MYT-30 agent.

## MYT-30 handoff checklist

When the MYT-30 agent picks up, it should be able to do:

```hcl
data "terraform_remote_state" "shared" {
  backend = "s3"
  config  = {
    bucket = "mythrun-terraform-state"
    key    = "environments/shared/terraform.tfstate"
    region = "us-east-1"
  }
}

# Attach wildcard cert to staging ALB listener
certificate_arn = data.terraform_remote_state.shared.outputs.wildcard_cert_arn

# Create staging-api A-alias record in the shared zone
zone_id = data.terraform_remote_state.shared.outputs.dns_zone_id
name    = "staging-api.${data.terraform_remote_state.shared.outputs.dns_zone_name}"
```

No other DNS or cert resources needed in staging workspace. MYT-30 is purely compute + the one A-alias.

## Out of scope, filed as future work

- Wildcard cert renewal monitoring — ACM auto-renews, CloudWatch alarm can come later.
- Route 53 health checks — useful for multi-region failover; not launch-critical.
- DNSSEC — Route 53 supports it but it's a non-trivial operational commitment; defer.
- `api.mythrun.com` and CloudFront apex/www records — per-milestone additions, not MYT-26.
- Replacing Google Workspace DKIM with a new key after cutover — Google's DKIM selector is stable; the existing key keeps working. Rotation is a separate concern.
