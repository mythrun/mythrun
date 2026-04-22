# ======== Public hosted zone ========
#
# Creating this resource does NOT change DNS globally. It provisions an AWS-side
# copy of the zone and assigns us 4 nameservers. Squarespace remains authoritative
# until a human updates the registrar's NS records (Task 5).

resource "aws_route53_zone" "main" {
  name    = var.domain_name
  comment = "Mythrun production DNS — managed by Terraform"

  tags = { Name = var.domain_name }
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
#
# DNS TXT strings have a 255-octet-per-string wire-format limit. DKIM public
# keys are ~256-400 chars, so we emit multiple substrings joined by the
# literal sequence `" "` — Route 53 rejects a single Value longer than 255
# chars. The AWS provider adds outer double-quotes to each element in
# `records`, so our expression must produce `chunk1" "chunk2` (unquoted on
# the outside, quoted-and-spaced between chunks). After the provider wraps,
# Route 53 receives `"chunk1" "chunk2"` as a single multi-string TXT value.
#
# Input contract: var.dkim_key_rrdata is the raw DKIM value (v=DKIM1;k=rsa;p=...
# with the full ~256-400 char body). Caller doesn't need to know about DNS
# wire format.
resource "aws_route53_record" "dkim" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "google._domainkey.${var.domain_name}"
  type    = "TXT"
  ttl     = 300

  records = [
    join("\" \"", [
      for i in range(0, length(var.dkim_key_rrdata), 255) :
      substr(var.dkim_key_rrdata, i, 255)
    ]),
  ]
}

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
