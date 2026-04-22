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
