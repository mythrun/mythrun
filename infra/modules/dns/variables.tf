variable "domain_name" {
  description = "Apex domain (no trailing dot). Example: \"mythrun.com\"."
  type        = string
}

variable "dkim_key_rrdata" {
  description = "Full DKIM TXT record value. Starts with v=DKIM1;k=rsa;p= followed by the base64 public key body. No default — caller must supply."
  type        = string
}
