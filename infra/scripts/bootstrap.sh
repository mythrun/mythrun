#!/usr/bin/env bash
set -euo pipefail

BUCKET="mythrun-terraform-state"
REGION="us-east-1"

echo "Bootstrapping Terraform state bucket in $REGION..."

# Fail fast if Terraform < 1.10 (required for use_lockfile native S3 locking)
TF_VERSION=$(terraform version -json 2>/dev/null | jq -r .terraform_version 2>/dev/null || echo "missing")
if [[ "$TF_VERSION" == "missing" ]]; then
  echo "ERROR: terraform not found on PATH. Install Terraform >= 1.10." >&2
  exit 1
fi
TF_MAJOR=$(echo "$TF_VERSION" | cut -d. -f1)
TF_MINOR=$(echo "$TF_VERSION" | cut -d. -f2)
if (( TF_MAJOR < 1 )) || (( TF_MAJOR == 1 && TF_MINOR < 10 )); then
  echo "ERROR: Terraform $TF_VERSION detected; >= 1.10 required for native S3 state locking." >&2
  exit 1
fi
echo "Terraform $TF_VERSION — OK."

# Create bucket if it doesn't exist (idempotent)
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3 mb "s3://$BUCKET" --region "$REGION"
  echo "Created bucket: $BUCKET"
else
  echo "Bucket $BUCKET already exists — skipping creation."
fi

# Enable versioning (idempotent)
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# Block all public access (idempotent)
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Require TLS for all requests (deny non-TLS)
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyNonTLS",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::$BUCKET",
        "arn:aws:s3:::$BUCKET/*"
      ],
      "Condition": {
        "Bool": { "aws:SecureTransport": "false" }
      }
    }
  ]
}
EOF
)"

# Expire noncurrent versions after 90 days
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules": [
    {
      "ID": "ExpireNoncurrentVersions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
    }
  ]
}'

# Tag the bucket
aws s3api put-bucket-tagging \
  --bucket "$BUCKET" \
  --tagging 'TagSet=[{Key=Project,Value=mythrun},{Key=ManagedBy,Value=manual},{Key=Environment,Value=shared}]'

echo "Done."
echo "  - SSE-S3 encryption on by default (AWS default since Jan 2023)"
echo "  - Public access blocked (all 4 settings)"
echo "  - TLS-only (aws:SecureTransport=false denied)"
echo "  - Versioning enabled; noncurrent versions expire after 90 days"
echo "  - Native S3 state locking via use_lockfile in backend.tf (Terraform >=1.10)"
