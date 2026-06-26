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
