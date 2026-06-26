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
