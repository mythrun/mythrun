# Route 53 Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move authoritative DNS for `mythrun.com` from Squarespace to a new Route 53 hosted zone, preserving all 9 email records so Google Workspace mail continues to flow, and pre-provision a DNS-validated wildcard ACM certificate that MYT-30 will attach to the staging ALB.

**Architecture:** New `infra/modules/dns/` module called from `environments/shared/` (the zone + cert are cross-env — both staging and future prod consume them). Two-phase apply pattern around the human NS-swap: targeted first apply creates zone + records + cert (cert enters `PENDING_VALIDATION`); Miklos swaps nameservers at Squarespace; second unrestricted apply lets the ACM validation waiter complete.

**Tech Stack:** Terraform ≥1.10, AWS provider `~> 6.0`, Route 53, ACM (us-east-1).

**Linear issue:** MYT-26
**Design spec:** `docs/superpowers/specs/2026-04-22-route53-cutover-design.md`

---

## Pre-flight notes

- **Real AWS spend delta:** +$0.50/mo (one Route 53 hosted zone). ACM certs are free. Nothing else incurs cost in this ticket.
- **The shared workspace is already applied** from MYT-25 (36 resources). MYT-26 is additive — `terraform plan` right now shows `0 to add, 0 to change, 0 to destroy`. After this plan lands, the second `terraform plan` should again show `No changes`.
- **Two-phase apply is deliberate.** ACM DNS validation requires the zone to be authoritative before resolvers can fetch the validation CNAME records. Between phases, Miklos updates nameservers at Squarespace. Running Terraform in phases avoids holding a long-running apply open across a human action.
- **DKIM public keys are public.** They are published in DNS for the world to read. Committing the full value to Terraform is correct and not a secrets concern.
- **Gmail risk window:** 5–60 min between the Squarespace NS swap and full propagation. Pick a quiet time. Rollback = point NS back to Squarespace (same 5–60 min re-propagation). Undelivered mail is queued by sending MTAs for 24–48h, so nothing is permanently lost even in a worst-case rollback.
- **`dig` command reminder:** `dig @<server> +short <type> <name>` queries a specific DNS server directly. We use this to verify records against the new AWS nameservers *before* they become authoritative globally — bypasses whatever the rest of the internet currently thinks is authoritative.
- **What ACM DNS validation does:** when we create the cert, ACM gives us a `_<hash>.mythrun.com` CNAME record value it expects to see in DNS. Terraform creates that CNAME in our Route 53 zone. Once the zone is authoritative (post-NS-swap), ACM polls the CNAME, confirms it matches, and flips the cert status from `PENDING_VALIDATION` to `ISSUED`. No private keys cross the wire — AWS proves domain control by watching us publish a record.

---

## File structure

### New files

- `infra/modules/dns/main.tf` — hosted zone, 4 email record resources (MX + 3 TXTs), ACM cert, cert-validation CNAME records, cert-validation waiter.
- `infra/modules/dns/variables.tf` — `domain_name`, `dkim_key_rrdata` (no default for DKIM — force caller to supply).
- `infra/modules/dns/outputs.tf` — `zone_id`, `zone_name`, `name_servers`, `wildcard_cert_arn`.

### Modified files

- `infra/environments/shared/main.tf` — append a `module "dns"` call with the DKIM value passed in as a variable.
- `infra/environments/shared/outputs.tf` — append 4 outputs re-exporting the DNS module outputs.

### Unchanged

- Everything under `infra/modules/network/`, `infra/modules/data/`, `infra/environments/staging/` — MYT-26 does not touch these.

---

## Task 1: Author `modules/dns/` — zone + email records

**Goal:** Terraform module scaffolded with the hosted zone and all 9 email records (5 MX + 4 TXT). No cert logic yet.

**Files:**
- Create: `infra/modules/dns/variables.tf`
- Create: `infra/modules/dns/main.tf` (partial — zone + records only)
- Create: `infra/modules/dns/outputs.tf` (partial — zone outputs only)

### Steps

- [ ] **Step 1: Create the module directory**

```bash
mkdir -p infra/modules/dns
```

- [ ] **Step 2: Create `infra/modules/dns/variables.tf`**

```hcl
variable "domain_name" {
  description = "Apex domain (no trailing dot). Example: \"mythrun.com\"."
  type        = string
}

variable "dkim_key_rrdata" {
  description = "Full DKIM TXT record value. Starts with v=DKIM1;k=rsa;p= followed by the base64 public key body. No default — caller must supply."
  type        = string
}
```

- [ ] **Step 3: Create `infra/modules/dns/main.tf`**

```hcl
# ======== Public hosted zone ========
#
# Creating this resource does NOT change DNS globally. It provisions an AWS-side
# copy of the zone and assigns us 4 nameservers. Squarespace remains authoritative
# until a human updates the registrar's NS records (Task 5).

resource "aws_route53_zone" "main" {
  name    = var.domain_name
  comment = "Mythrun production DNS — managed by Terraform"

  tags = { Name = "mythrun-com" }
}

# ======== Email records (preserve exactly from Squarespace audit) ========
#
# Record-for-record replica of what Squarespace currently serves. TTLs dropped
# to 300 from Squarespace's 1800-14400 so mistakes propagate fixes faster.

# 5 MX records at apex, all in one resource (DNS collapses them into one RRSET)
resource "aws_route53_record" "mx" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "MX"
  ttl     = 300

  records = [
    "1 aspmx.l.google.com.",
    "5 alt1.aspmx.l.google.com.",
    "5 alt2.aspmx.l.google.com.",
    "10 alt3.aspmx.l.google.com.",
    "10 alt4.aspmx.l.google.com.",
  ]
}

# Apex TXT records collapse into one RRSET (SPF + Google site verification)
resource "aws_route53_record" "apex_txt" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "TXT"
  ttl     = 300

  records = [
    "v=spf1 include:_spf.google.com ~all",
    "google-site-verification=wFPzLNmQdEDr4YIbu6EdooFMeEpUvEtOTt2OX7QlYs0",
  ]
}

# DMARC policy at _dmarc subdomain
resource "aws_route53_record" "dmarc" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 300

  records = [
    "v=DMARC1; p=quarantine; rua=mailto:dev@mythrun.com",
  ]
}

# DKIM public key at google._domainkey subdomain.
# The DKIM value exceeds DNS's 255-char-per-string limit. The AWS Terraform
# provider auto-chunks when records is a list of strings >255 chars, splitting
# at 255-char boundaries. We pass the raw value and let the provider handle it.
resource "aws_route53_record" "dkim" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "google._domainkey.${var.domain_name}"
  type    = "TXT"
  ttl     = 300

  records = [var.dkim_key_rrdata]
}
```

- [ ] **Step 4: Create `infra/modules/dns/outputs.tf`**

```hcl
output "zone_id" {
  value       = aws_route53_zone.main.zone_id
  description = "Route 53 zone ID for consumption by staging and production workspaces."
}

output "zone_name" {
  value       = aws_route53_zone.main.name
  description = "Zone name (apex domain, no trailing dot)."
}

output "name_servers" {
  value       = aws_route53_zone.main.name_servers
  description = "Four AWS nameservers to set at the registrar (Squarespace). Displayed after apply."
}
```

- [ ] **Step 5: Format the module**

```bash
cd infra/modules/dns && terraform fmt && cd -
```

Expected: silent (files are already formatted) or prints rewritten filenames.

- [ ] **Step 6: Commit**

```bash
git add infra/modules/dns/
git commit -m "$(cat <<'EOF'
feat(infra): dns module scaffold — zone + email records

Creates infra/modules/dns/ with:
- aws_route53_zone for the apex domain (parameterized via domain_name var)
- 5 MX records (Google Workspace mail servers, priorities 1/5/5/10/10)
- Apex TXT records (SPF + Google site verification, collapsed into one RRSET)
- _dmarc TXT record (DMARC policy: p=quarantine, rua=dev@)
- google._domainkey TXT (DKIM public key, value passed in via var since the
  body is a 256-char RSA public key and we want the module reusable)

All records TTL=300 (Squarespace had 1800-14400; lower TTL means mistakes
propagate fixes in 5 min instead of 4h).

No ACM cert yet — separate commit so review is scoped. No caller yet —
shared workspace wires this up in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add wildcard ACM cert to `modules/dns/`

**Goal:** Append the wildcard certificate, its DNS validation CNAME records, and the validation waiter to the DNS module. Still no caller.

**Files:**
- Modify: `infra/modules/dns/main.tf` (append cert + validation resources)
- Modify: `infra/modules/dns/outputs.tf` (append `wildcard_cert_arn`)

### Steps

- [ ] **Step 1: Append the ACM cert to `infra/modules/dns/main.tf`**

At the end of the file (after the DKIM resource), append:

```hcl
# ======== Wildcard ACM certificate ========
#
# Covers the apex (mythrun.com) plus any single-label subdomain (staging-api,
# api, www). Two-label subdomains would require separate SANs — not a concern
# for launch.
#
# validation_method = "DNS" means ACM gives us a CNAME record to publish; it
# then polls that CNAME to prove domain control. No private keys traverse the
# public internet.

resource "aws_acm_certificate" "wildcard" {
  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "mythrun-wildcard" }
}

# Publish the CNAME records ACM asks for. In the common case of apex + wildcard
# sharing a parent domain, ACM dedupes and returns a single validation option.
# for_each handles both cases (1 or 2 options).

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  zone_id         = aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
}

# Waits until ACM flips the cert to ISSUED. This resource can sit in
# "Still creating..." for ~5-30 min the first time because ACM only starts
# validating once the zone is globally authoritative (post-NS-swap). We avoid
# that wait by running the first `terraform apply` with -target flags that
# EXCLUDE this resource, letting us cut over nameservers between applies.

resource "aws_acm_certificate_validation" "wildcard" {
  certificate_arn         = aws_acm_certificate.wildcard.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}
```

- [ ] **Step 2: Append the cert output to `infra/modules/dns/outputs.tf`**

At the end of the file, append:

```hcl
output "wildcard_cert_arn" {
  value       = aws_acm_certificate_validation.wildcard.certificate_arn
  description = "ACM certificate ARN for *.mythrun.com (+ apex SAN). Sourced from the validation waiter so consumers can't use an unvalidated cert."
  sensitive   = false
}
```

(Not sensitive: cert ARNs are in CloudTrail logs and don't expose key material.)

- [ ] **Step 3: Format**

```bash
cd infra/modules/dns && terraform fmt && cd -
```

- [ ] **Step 4: Commit**

```bash
git add infra/modules/dns/main.tf infra/modules/dns/outputs.tf
git commit -m "$(cat <<'EOF'
feat(infra): dns module — wildcard ACM cert + DNS validation

Adds aws_acm_certificate for *.mythrun.com (+ mythrun.com as SAN), its
DNS-validation CNAME records via for_each over domain_validation_options,
and the aws_acm_certificate_validation waiter.

The waiter's certificate_arn is what outputs.tf re-exports, so downstream
consumers can't accidentally attach an unvalidated cert to an ALB.

Validation only succeeds once Route 53 is globally authoritative for
mythrun.com, which happens after the human NS swap at Squarespace.
Operationally we handle this by running a targeted first apply that stops
before the validation waiter, doing the cutover, then running a clean
second apply.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire DNS module into the shared workspace

**Goal:** `environments/shared/` calls `module "dns"` and re-exports its outputs for downstream workspaces.

**Files:**
- Modify: `infra/environments/shared/main.tf` (append module call)
- Modify: `infra/environments/shared/outputs.tf` (append 4 outputs)

### Steps

- [ ] **Step 1: Append to `infra/environments/shared/main.tf`**

At the end of the file (after the existing `module "network"` and `module "data"` calls), append:

```hcl
module "dns" {
  source      = "../../modules/dns"
  domain_name = "mythrun.com"

  # Full DKIM public key pulled from the Squarespace DNS export (MYT-26 audit,
  # 2026-04-22). Public values — DNS publishes them globally, not a secret.
  dkim_key_rrdata = "v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmahZYAC+S0RRJLvVmIx2Pp2P73HT30vgVxskC0hqpqCQlCAAoubNMlMzOC3QJnIlZ2fYEoqV9k0G9pjev/6tlMsVAyvrhBC+dNdRhkPRpDm9v5dXhdghoB9NlNNTb4R0Rb5r8UUyG3xckDZoEut6AaopWhce5qyXZN98FCwJPqrHkJRhnfIza8PfNwEJKw7tx43dRGpdYWumsPNFGl8O0+HixtMDbzjo4Eg0GetYIdIqD7heXV7I4cD1TVj/9X4zGiBSh8U55vgwMGwu+7ZowO3lbm9fA7+E7dCsRaIC7sNJMdkn4NzzuKEBaJb9TkO/EGFMzcWXoxbYhcckE5eJMQIDAQAB"
}
```

- [ ] **Step 2: Append to `infra/environments/shared/outputs.tf`**

At the end of the file, append:

```hcl
# ======== DNS outputs ========
# Consumed by staging (MYT-30) and future production workspaces via
# data.terraform_remote_state.shared — they read zone_id to create A-alias
# records and wildcard_cert_arn to attach to their ALB listeners.

output "dns_zone_id" {
  value = module.dns.zone_id
}

output "dns_zone_name" {
  value = module.dns.zone_name
}

output "name_servers" {
  value       = module.dns.name_servers
  description = "Set these four at Squarespace Domains → DNS → Nameservers → Custom."
}

output "wildcard_cert_arn" {
  value = module.dns.wildcard_cert_arn
}
```

- [ ] **Step 3: Format**

```bash
cd infra/environments/shared && terraform fmt && cd -
```

- [ ] **Step 4: Terraform init (picks up the new module)**

```bash
cd infra/environments/shared && terraform init && cd -
```

Expected: `Initializing modules...` lists `dns` among the modules. Ends with `Terraform has been successfully initialized!`.

- [ ] **Step 5: Terraform validate**

```bash
cd infra/environments/shared && terraform validate && cd -
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 6: Terraform plan — confirm ~15 new resources**

```bash
cd infra/environments/shared && terraform plan -no-color 2>&1 | grep -E "^(Plan:|#.*will be created)" && cd -
```

Expected:
- `Plan: 14 to add, 0 to change, 0 to destroy.` (1 zone + 4 email records + 1 cert + 1-2 cert validation CNAMEs + 1 validation waiter; exact count depends on how many validation options ACM returns — apex + wildcard usually dedupes to a single CNAME, making the total 14; if ACM returns two distinct options, total is 15).

If any existing MYT-25 resource appears in the `will be updated` or `will be destroyed` list, **STOP** — something is wrong. Investigate before proceeding. Expected result is purely additive.

- [ ] **Step 7: Commit**

```bash
git add infra/environments/shared/main.tf infra/environments/shared/outputs.tf
git commit -m "$(cat <<'EOF'
feat(infra): wire dns module into shared workspace

Adds module "dns" call with mythrun.com + full DKIM value from the MYT-26
Squarespace audit. Re-exports dns_zone_id, dns_zone_name, name_servers,
wildcard_cert_arn for consumption by staging/production workspaces via
data.terraform_remote_state.shared (MYT-30 wires the staging-api A-alias
and attaches the wildcard cert to its ALB listener).

`terraform plan` reports 14 resources to add, 0 to change, 0 to destroy
— purely additive to the existing 36 MYT-25 resources.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Targeted first apply — create zone + records + cert (PENDING_VALIDATION)

**Goal:** Apply everything except the ACM validation waiter. After this task, the zone and all records exist in AWS; Squarespace is still globally authoritative; the cert sits in `PENDING_VALIDATION` because its validation records can't be reached by resolvers yet.

**Files:** none (apply only).

**Miklos approval gate:** this apply creates real AWS resources. Ask for explicit approval before running.

### Steps

- [ ] **Step 1: Confirm Miklos approval before applying**

Ask: "Ready to apply the zone + email records + cert? Creates 13-14 resources in shared (Route 53 zone, 9 email records, cert + validation CNAMEs — NOT the validation waiter). ~$0.50/mo delta. Fully reversible with `terraform destroy -target=module.dns`."

Wait for explicit go-ahead.

- [ ] **Step 2: Run the targeted apply**

```bash
cd infra/environments/shared
terraform apply -auto-approve \
  -target=module.dns.aws_route53_zone.main \
  -target=module.dns.aws_route53_record.mx \
  -target=module.dns.aws_route53_record.apex_txt \
  -target=module.dns.aws_route53_record.dmarc \
  -target=module.dns.aws_route53_record.dkim \
  -target=module.dns.aws_acm_certificate.wildcard \
  -target=module.dns.aws_route53_record.cert_validation
cd -
```

Expected: `Apply complete! Resources: 13 added, 0 changed, 0 destroyed.` (or 14 if ACM returned two validation options). Apply finishes in ~30 seconds (no RDS-style multi-minute waits).

Note: Terraform will print a warning about `-target` being intended for exceptional cases — that's expected. Our two-phase pattern is exactly the exceptional case the warning anticipates.

- [ ] **Step 3: Capture the four AWS nameservers**

```bash
cd infra/environments/shared
terraform output -json name_servers | jq -r '.[]'
cd -
```

Expected output: 4 lines, each a hostname like `ns-XXX.awsdns-XX.{com,net,org,co.uk}`. Example:
```
ns-123.awsdns-15.com
ns-456.awsdns-56.net
ns-789.awsdns-89.co.uk
ns-1234.awsdns-12.org
```

**Write these down** — you'll paste them into Squarespace in Task 6.

- [ ] **Step 4: Confirm cert is in PENDING_VALIDATION**

```bash
CERT_ARN=$(aws acm list-certificates --query "CertificateSummaryList[?DomainName=='mythrun.com'].CertificateArn" --output text)
aws acm describe-certificate --certificate-arn "$CERT_ARN" --query 'Certificate.Status' --output text
```

Expected: `PENDING_VALIDATION`.

This is correct at this stage. The cert moves to `ISSUED` after the NS cutover (Tasks 6-7).

---

## Task 5: Verify records against AWS nameservers directly

**Goal:** Before touching Squarespace, confirm every record in Route 53 exactly matches the Squarespace audit. Query the new AWS nameservers directly with `dig`, bypassing whatever the global internet currently thinks is authoritative.

**Files:** none (verification only).

### Steps

- [ ] **Step 1: Capture nameservers into a shell variable**

```bash
cd infra/environments/shared
NAMESERVERS=$(terraform output -json name_servers | jq -r '.[]')
echo "$NAMESERVERS"
cd -
```

Expected: 4 `ns-*.awsdns-*.{com,net,org,co.uk}` lines.

- [ ] **Step 2: Probe MX records against each nameserver**

```bash
for ns in $NAMESERVERS; do
  echo "=== $ns ==="
  dig @$ns +short MX mythrun.com
done
```

Expected (per nameserver, order may vary within the group):
```
=== ns-XXX.awsdns-XX.com ===
1 aspmx.l.google.com.
5 alt1.aspmx.l.google.com.
5 alt2.aspmx.l.google.com.
10 alt3.aspmx.l.google.com.
10 alt4.aspmx.l.google.com.
```

**Gate:** every nameserver returns the same 5 MX records with exactly those priorities and hostnames. If any mismatch, stop and fix — don't proceed to Squarespace.

- [ ] **Step 3: Probe apex TXT records**

```bash
for ns in $NAMESERVERS; do
  echo "=== $ns ==="
  dig @$ns +short TXT mythrun.com
done
```

Expected (order within a nameserver may vary):
```
=== ns-XXX.awsdns-XX.com ===
"v=spf1 include:_spf.google.com ~all"
"google-site-verification=wFPzLNmQdEDr4YIbu6EdooFMeEpUvEtOTt2OX7QlYs0"
```

**Gate:** both strings present on every nameserver, verbatim.

- [ ] **Step 4: Probe DMARC record**

```bash
for ns in $NAMESERVERS; do
  echo "=== $ns ==="
  dig @$ns +short TXT _dmarc.mythrun.com
done
```

Expected:
```
=== ns-XXX.awsdns-XX.com ===
"v=DMARC1; p=quarantine; rua=mailto:dev@mythrun.com"
```

**Gate:** exact string on every nameserver.

- [ ] **Step 5: Probe DKIM record**

```bash
for ns in $NAMESERVERS; do
  echo "=== $ns ==="
  dig @$ns +short TXT google._domainkey.mythrun.com
done
```

Expected:
```
=== ns-XXX.awsdns-XX.com ===
"v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmahZYAC+S0RRJLvVmIx2Pp2P73HT30vgVxskC0hqpqCQlCAAoubNMlMzOC3QJnIlZ2fYEoqV9k0G9pjev/6tlMsVAyvrhBC+dNdRhkPRpDm9v5dXhdghoB9NlNNTb4R0Rb5r8UUyG3xckDZoEut6AaopWhce5qyXZN98FCwJPqrHkJRhnfIza8PfNwEJKw7tx43dRGpdYWumsPNFGl8O0+HixtMDbzjo4Eg0GetYIdIqD7heXV7I4cD1TVj/9X4zGiBSh8U55vgwMGwu+7ZowO3lbm9fA7+E7dCsRaIC7sNJMdkn4NzzuKEBaJb9TkO/EGFMzcWXoxbYhcckE5eJMQIDAQAB"
```

Note: `dig`'s `+short` output will display the TXT value as one or more quoted strings depending on chunking. As long as the concatenation of all quoted segments equals the full DKIM value above, the record is correct. Most dig versions reassemble and show it as one line; some split at the 255-char boundary (two strings: first 255 chars in one `"..."`, remainder in another). Both are equivalent at the DNS wire level.

**Gate:** reassembled string equals the full expected DKIM value on every nameserver.

- [ ] **Step 6: Verify cert validation CNAME is present**

```bash
for ns in $NAMESERVERS; do
  echo "=== $ns ==="
  dig @$ns +short TXT mythrun.com | head -2  # just so we're hitting the zone
  # ACM gives unique CNAME names per validation; check the cert to find the name
done

# Pull the exact CNAME name + value from ACM:
CERT_ARN=$(aws acm list-certificates --query "CertificateSummaryList[?DomainName=='mythrun.com'].CertificateArn" --output text)
aws acm describe-certificate --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output table
```

Expected: the `aws acm describe-certificate` call prints a CNAME name like `_abc123def456.mythrun.com.` pointing at `_xyz789.acm-validations.aws.`. Query that CNAME:

```bash
VALIDATION_CNAME_NAME=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)
for ns in $NAMESERVERS; do
  echo "=== $ns ==="
  dig @$ns +short CNAME "$VALIDATION_CNAME_NAME"
done
```

Expected: each nameserver returns the `_xyz789.acm-validations.aws.` target.

**Gate:** validation CNAME resolvable on every nameserver.

---

## Task 6: Human action — swap nameservers at Squarespace

**Goal:** Miklos updates the registrar's nameservers from Squarespace's defaults to the 4 AWS nameservers captured in Task 4.

**Files:** none (manual step in the Squarespace web UI).

**This is the cutover moment.** Between the NS update and full global propagation (5–60 min), different resolvers will return different authoritative answers. Email delivery is more tolerant than web (sending MTAs retry for days), so email downtime during the gap is typically zero in practice — but it's the window where theoretical risk exists.

### Steps

- [ ] **Step 1: Confirm the 4 AWS nameservers are captured**

Re-run Task 4 Step 3 if you've lost the values:

```bash
cd infra/environments/shared && terraform output -json name_servers | jq -r '.[]'
```

Copy them to a scratchpad.

- [ ] **Step 2: Miklos updates nameservers at Squarespace Domains**

Instruction for Miklos:

1. Log in to Squarespace Domains at https://account.squarespace.com/domains
2. Click `mythrun.com`
3. Find the "Nameservers" section (may be under "DNS Settings" or "Advanced")
4. Switch from "Squarespace nameservers" to "Custom nameservers"
5. Paste the 4 AWS nameservers (one per row, no trailing dot required — Squarespace will normalize)
6. Save / Apply

Expected: Squarespace confirms the change. May display a propagation warning ("changes can take up to 48 hours") — that's general guidance; our actual propagation for fresh zones is 5–60 min because the old Squarespace NS records have a 172800s (48h) default TTL but resolvers re-check SOA frequently.

- [ ] **Step 3: Wait for Miklos confirmation**

Miklos replies "done" or equivalent. Don't proceed to propagation watch until this confirmation.

---

## Task 7: Propagation watch

**Goal:** Poll 4 external resolvers until they all return AWS nameservers for `mythrun.com` — signals that the NS update has propagated globally.

**Files:** none (monitoring only).

### Steps

- [ ] **Step 1: Run the propagation watch loop**

```bash
until \
  dig @1.1.1.1   +short NS mythrun.com | grep -q awsdns && \
  dig @8.8.8.8   +short NS mythrun.com | grep -q awsdns && \
  dig @9.9.9.9   +short NS mythrun.com | grep -q awsdns && \
  dig @208.67.222.222 +short NS mythrun.com | grep -q awsdns ; do
  echo "$(date +%H:%M:%S) — still seeing old NS on at least one resolver"
  sleep 60
done
echo "All resolvers returning AWS nameservers."
```

Expected: loops for 5–60 min, eventually prints "All resolvers returning AWS nameservers."

The 4 resolvers picked:
- `1.1.1.1` — Cloudflare
- `8.8.8.8` — Google Public DNS
- `9.9.9.9` — Quad9
- `208.67.222.222` — OpenDNS

Together they cover a representative slice of the internet's cache state. When all four agree on AWS NS, the zone is effectively authoritative globally.

- [ ] **Step 2: Confirm one of the resolvers can resolve an email record via the new NS path**

```bash
dig @1.1.1.1 +short MX mythrun.com
```

Expected: the 5 Google MX records, proving resolvers are now walking the NS chain down to AWS and back.

---

## Task 8: Final unrestricted apply — ACM validation waiter completes

**Goal:** Run `terraform apply` without `-target` flags. The previously-missing `aws_acm_certificate_validation.wildcard` waiter runs; since the validation records have been globally resolvable since Task 7, ACM sees the proof and transitions the cert from `PENDING_VALIDATION` to `ISSUED` within seconds.

**Files:** none (apply only).

### Steps

- [ ] **Step 1: Run the unrestricted apply**

```bash
cd infra/environments/shared
terraform apply -auto-approve
cd -
```

Expected: `Apply complete! Resources: 1 added, 0 changed, 0 destroyed.` The "1 added" is the `aws_acm_certificate_validation.wildcard` resource. Apply completes in under a minute.

- [ ] **Step 2: Confirm cert status is ISSUED**

```bash
CERT_ARN=$(aws acm list-certificates --query "CertificateSummaryList[?DomainName=='mythrun.com'].CertificateArn" --output text)
aws acm describe-certificate --certificate-arn "$CERT_ARN" --query 'Certificate.Status' --output text
```

Expected: `ISSUED`.

- [ ] **Step 3: Idempotency gate — second plan reports "No changes"**

```bash
cd infra/environments/shared
terraform plan -detailed-exitcode -no-color > /tmp/myt26-plan.txt 2>&1
echo "Plan exit: $?"
grep -E "^(No changes|Plan:)" /tmp/myt26-plan.txt
cd -
```

Expected: `Plan exit: 0` and `No changes. Your infrastructure matches the configuration.`

Exit 0 means no diff. If exit is 2 (diff present), inspect `/tmp/myt26-plan.txt` and reconcile — may be the rds.force_ssl apply_method quirk resurfacing (unlikely since we already fixed it in MYT-25), or some new drift.

---

## Task 9: Email smoke test (human action)

**Goal:** End-to-end confirmation that Gmail still flows in both directions and SPF/DKIM/DMARC all pass.

**Files:** none.

### Steps

- [ ] **Step 1: Miklos sends an email FROM a mythrun.com address TO a personal Gmail**

Instruction for Miklos:
1. Send an email from `dev@mythrun.com` (or whichever mythrun mailbox) to a personal Gmail address.
2. Open the personal Gmail, find the message.
3. Click "Show original" (Gmail menu: the three-dot "⋮" icon → Show original).
4. In the headers, look for `Authentication-Results:`. It should show:
   - `spf=pass` (SPF header check)
   - `dkim=pass` (DKIM signature check against the `google._domainkey` TXT record we just migrated)
   - `dmarc=pass` (DMARC alignment check)

If any fails, that's a real problem — the mail system is reading our Route 53 records and something's off. Do not close MYT-26.

- [ ] **Step 2: Miklos sends an email FROM a personal Gmail TO a mythrun.com address**

Instruction:
1. Send from a personal Gmail to `dev@mythrun.com`.
2. Open Gmail for `dev@mythrun.com`. The message should arrive within a minute.

If it doesn't arrive in ~5 min, check Google Workspace admin → Reports → Email Log Search to see if Google received or rejected the inbound message. Failures here usually indicate the MX records are wrong or caching is still in flight.

- [ ] **Step 3: Miklos confirms both directions succeed**

Reply "smoke test passed" or similar. This is the final gate before closing MYT-26.

---

## Task 10: Close-out — Linear comment, close ticket, push

**Goal:** Make MYT-26's deliverables explicit for the MYT-30 agent, close the Linear issue, and push everything to origin.

**Files:** none (Linear + git only).

### Steps

- [ ] **Step 1: Post a close-out comment on MYT-26**

Use the `mcp__linear-server__save_comment` tool to add a comment with:

```markdown
## MYT-26 cutover complete (2026-04-XX)

**For the MYT-30 agent:** Four outputs are live in the shared workspace state, consumable from the staging workspace via `data.terraform_remote_state.shared.outputs.*`:

| Output | Purpose |
|--------|---------|
| `dns_zone_id` | Route 53 zone ID — set on `aws_route53_record.staging_api` |
| `dns_zone_name` | `mythrun.com` — compose the record name: `"staging-api.${...}"` |
| `name_servers` | The 4 AWS nameservers (informational — the NS swap is already done) |
| `wildcard_cert_arn` | ARN of the validated `*.mythrun.com` cert — attach to the ALB HTTPS listener |

**What was built in MYT-26:**

- Route 53 public hosted zone for `mythrun.com`
- 9 email records replicated exactly from the Squarespace audit (5 MX + 4 TXT — SPF, Google verification, DMARC, DKIM)
- Wildcard ACM certificate (`*.mythrun.com` + `mythrun.com` SAN), DNS-validated
- Nameservers swapped at Squarespace → AWS NS globally propagated
- Email smoke test passed in both directions with SPF/DKIM/DMARC all passing

**NOT in MYT-26 (your scope in MYT-30):**

- `staging-api.mythrun.com` A-alias record pointing at the staging ALB
- Attachment of the wildcard cert to the staging ALB HTTPS listener

**Unchanged from MYT-25:** network + data modules, 36 existing resources. The shared workspace is now at 50 resources total (36 + 14). Idempotency gate clean.
```

Fill in the exact date.

- [ ] **Step 2: Close MYT-26 in Linear**

Use `mcp__linear-server__save_issue` with `id="MYT-26"` and `state="Done"`.

- [ ] **Step 3: Push to origin**

```bash
git push origin main
```

Expected: commits from Tasks 1, 2, 3 (module scaffold, cert, wiring) pushed. The apply runs don't create commits.

- [ ] **Step 4: Close out beads**

Mark all MYT-26 beads as closed with `bd close <id>` and a short reason pointing at the Linear close-out comment.

