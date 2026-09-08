# Tropis application policy — read-only access to app secrets.
#
# This file is for reference / manual application only. init.sh does NOT read
# it — it writes the same policy from an inline heredoc. Keep the two in sync.
#
# In production this policy would be attached to a Kubernetes service account
# via Vault's Kubernetes auth method instead of a static token:
#
#   vault auth enable kubernetes
#   vault write auth/kubernetes/role/tropis-app \
#     bound_service_account_names=tropis-app \
#     bound_service_account_namespaces=default \
#     policies=tropis-app \
#     ttl=1h

path "secret/data/tropis" {
  capabilities = ["read"]
}

path "secret/data/tropis/*" {
  capabilities = ["read"]
}

# Transit encryption + dynamic DB credentials — both used by
# apps/backend/src/infrastructure/vault/vault.service.ts.
path "transit/encrypt/user-data" {
  capabilities = ["update"]
}

path "transit/decrypt/user-data" {
  capabilities = ["update"]
}

path "database/creds/tropis-app" {
  capabilities = ["read"]
}

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
