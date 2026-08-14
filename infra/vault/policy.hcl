# Tropis application policy — read-only access to app secrets.
#
# This file is for reference / manual application.
# The init.sh script applies it automatically on container start.
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

path "auth/token/renew-self" {
  capabilities = ["update"]
}

path "auth/token/lookup-self" {
  capabilities = ["read"]
}
