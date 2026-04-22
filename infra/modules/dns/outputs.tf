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
  description = "Four AWS nameservers. Set these at Squarespace Domains → DNS → Custom nameservers to cut DNS over to AWS."
}

output "wildcard_cert_arn" {
  value       = aws_acm_certificate_validation.wildcard.certificate_arn
  description = "ACM certificate ARN for *.mythrun.com (+ apex SAN). Sourced from the validation waiter so consumers can't use an unvalidated cert."
  sensitive   = false
}
