variable "environment" {
  description = "Logical environment label for tagging."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for DB and Redis subnet groups. Must span 2 AZs (RDS requires ≥2 AZs in the subnet group even for Single-AZ instances)."
  type        = list(string)
}

variable "rds_sg_id" {
  description = "Security group ID for RDS."
  type        = string
}

variable "redis_sg_id" {
  description = "Security group ID for Redis."
  type        = string
}

variable "rds_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "rds_allocated_storage" {
  description = "Initial allocated storage (GB)."
  type        = number
  default     = 20
}

variable "rds_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GB)."
  type        = number
  default     = 50
}

variable "redis_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_engine_version" {
  description = "Redis engine version. Verify available versions with aws elasticache describe-cache-engine-versions."
  type        = string
  default     = "7.1"
}
