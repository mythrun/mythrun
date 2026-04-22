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
# keys are ~256-400 chars, so we must emit multiple quoted substrings joined
# by spaces — Route 53 rejects a single Value longer than 255 chars.
#
# Input contract: var.dkim_key_rrdata is the raw DKIM value (v=DKIM1;k=rsa;p=...
# with the full ~256-400 char body). We chunk it here so the caller doesn't
# have to know about DNS wire format. Output format: `"chunk1" "chunk2" ...`
# which Route 53 accepts as a single Value representing multi-string TXT rdata.
resource "aws_route53_record" "dkim" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "google._domainkey.${var.domain_name}"
  type    = "TXT"
  ttl     = 300

  records = [
    format(
      "\"%s\"",
      join("\" \"", [
        for i in range(0, length(var.dkim_key_rrdata), 255) :
        substr(var.dkim_key_rrdata, i, 255)
      ]),
    ),
  ]
}
