variable "environment" {
  description = "Logical environment label for tagging. One of: shared, staging, production."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "azs" {
  description = "Availability zones for subnet placement. Exactly 2 AZs at launch; list order matters (index 0 = 'a', index 1 = 'b')."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "num_nat_gateways" {
  description = "Number of NAT Gateways. 1 at launch (cost savings); bump to 2 when AZ-a outage tolerance is required (requires splitting private route table, handled automatically by this module when set to 2)."
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 2], var.num_nat_gateways)
    error_message = "num_nat_gateways must be 1 or 2."
  }
}
