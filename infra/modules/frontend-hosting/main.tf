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

# Dynamic API responses must never be cached. The /api/* behavior uses this.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards ALL viewer headers (Cookie, Authorization, Origin, Content-Type) + query
# + cookies to the API origin, EXCEPT Host — so the ALB/API sees its own host, not
# the SPA's staging.mythrun.com. The /api/* behavior uses this.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
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

  # Same-origin API proxy origin (MYT-84). The SPA calls staging.mythrun.com/api/*
  # so the BFF refresh cookie is set FIRST-PARTY; CloudFront forwards to the API ALB
  # (reached via its public FQDN). https-only — the ALB terminates the wildcard cert.
  origin {
    origin_id   = "api"
    domain_name = var.api_origin_domain

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-${aws_s3_bucket.site.id}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id

    # MODULE INVARIANT: if ordered cache behaviors are ever added, each must
    # carry the same viewer-request association, or it is a gate bypass path —
    # EXCEPT the /api/* behavior below, a DELIBERATE exemption (the API self-auths
    # and carries a Bearer / refresh cookie, not the Basic gate header; see there).
    dynamic "function_association" {
      for_each = var.enable_basic_auth ? [1] : []
      content {
        event_type   = "viewer-request"
        function_arn = aws_cloudfront_function.basic_auth[0].arn
      }
    }
  }

  # Same-origin API proxy (MYT-84 cookie fix). The SPA calls staging.mythrun.com/api/*
  # so the BFF refresh cookie is FIRST-PARTY — Safari refuses to store a cookie set via
  # a cross-origin fetch to the api subdomain. Caching disabled (dynamic); all viewer
  # headers + cookies forwarded (except Host).
  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id

    # DELIBERATE gate exemption (see the default_cache_behavior invariant): /api/*
    # carries a Bearer / the httpOnly refresh cookie, NOT the Basic gate header, so the
    # gate function can't apply. The API self-authenticates (JWT + the public-route
    # allowlist) and is already reachable at var.api_origin_domain — this proxy changes
    # the cookie's ORIGIN, not the API's exposure. So it is NOT an SPA-content bypass.
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

# ======== Route 53 A + AAAA aliases ========
# CloudFront's hosted zone id is the fixed global constant Z2FDTNDATAQYW2.
# The distribution is dual-stack (is_ipv6_enabled = true), so it gets BOTH an A
# and an AAAA alias — an IPv6-only client must be able to resolve the name.
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

resource "aws_route53_record" "site_ipv6" {
  zone_id = var.hosted_zone_id
  name    = var.site_domain
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = "Z2FDTNDATAQYW2"
    evaluate_target_health = false
  }
}
