#!/bin/sh
# Vault init script — seeds all secrets + enables AppRole, Transit, and dynamic DB.
# Runs once as a one-shot Docker container after Vault is healthy.
#
# What this script does:
#   1. Writes all app secrets to KV v2 (secret/tropis)
#   2. Creates a read-only policy for the app
#   3. Enables AppRole auth and creates an app role
#   4. Enables Transit secrets engine and creates an encryption key
#   5. Enables Database secrets engine and configures dynamic PostgreSQL credentials
#   6. Prints credentials for copy-paste into .env

set -e

echo ">>> Waiting for Vault..."
until vault status >/dev/null 2>&1; do sleep 1; done
echo ">>> Vault ready."

# ── 1. KV v2 — all static secrets ────────────────────────────────────────────

vault secrets enable -path=secret kv-v2 2>/dev/null || true

vault kv put secret/tropis \
  PORT="3100" GRPC_PORT="50051" NODE_ENV="development" \
  CORS_ORIGIN="http://localhost:5173" LOG_LEVEL="info" \
  JWT_SECRET="dev-jwt-secret-change-in-production" JWT_EXPIRES_IN="7d" \
  MONGODB_URI="mongodb://mongodb:27017/tropis" \
  REDIS_HOST="redis" REDIS_PORT="6379" REDIS_PASSWORD="" \
  CLICKHOUSE_HOST="http://clickhouse:8123" CLICKHOUSE_USER="default" \
  CLICKHOUSE_PASSWORD="" CLICKHOUSE_DATABASE="logs" \
  AEROSPIKE_HOST="aerospike" AEROSPIKE_PORT="3000" \
  PULSAR_SERVICE_URL="pulsar://pulsar:6650" \
  OTEL_SERVICE_NAME="nestjs-app" \
  OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4318/v1/traces" \
  POSTGRES_HOST="postgres" POSTGRES_PORT="5432" \
  POSTGRES_USER="tropis" POSTGRES_PASSWORD="tropis_dev_password" \
  POSTGRES_DB="tropis" POSTGRES_SSL="false" \
  ELASTICSEARCH_NODE="http://elasticsearch:9200" \
  MINIO_ENDPOINT="minio" MINIO_PORT="9900" MINIO_USE_SSL="false" \
  MINIO_ACCESS_KEY="minioadmin" MINIO_SECRET_KEY="minioadmin123" MINIO_BUCKET="app-uploads" \
  SMTP_HOST="mailhog" SMTP_PORT="1025" SMTP_FROM="noreply@tropis.local" \
  SMS_PROVIDER="stub"

# Grouped paths for human browsing in the UI
vault kv put secret/tropis/db \
  MONGODB_URI="mongodb://mongodb:27017/tropis" \
  POSTGRES_HOST="postgres" POSTGRES_PORT="5432" \
  POSTGRES_USER="tropis" POSTGRES_PASSWORD="tropis_dev_password" POSTGRES_DB="tropis" \
  CLICKHOUSE_HOST="http://clickhouse:8123" CLICKHOUSE_USER="default" \
  REDIS_HOST="redis" REDIS_PORT="6379" \
  ELASTICSEARCH_NODE="http://elasticsearch:9200"

vault kv put secret/tropis/auth \
  JWT_SECRET="dev-jwt-secret-change-in-production" JWT_EXPIRES_IN="7d"

vault kv put secret/tropis/messaging \
  PULSAR_SERVICE_URL="pulsar://pulsar:6650" REDIS_HOST="redis" REDIS_PORT="6379"

vault kv put secret/tropis/storage \
  MINIO_ENDPOINT="minio" MINIO_PORT="9900" \
  MINIO_ACCESS_KEY="minioadmin" MINIO_SECRET_KEY="minioadmin123" MINIO_BUCKET="app-uploads"

vault kv put secret/tropis/smtp \
  SMTP_HOST="mailhog" SMTP_PORT="1025" SMTP_FROM="noreply@tropis.local"

echo ">>> KV secrets written."

# ── 2. Policy ─────────────────────────────────────────────────────────────────

vault policy write tropis-app - <<'POLICY'
path "secret/data/tropis"   { capabilities = ["read"] }
path "secret/data/tropis/*" { capabilities = ["read"] }
path "transit/encrypt/user-data" { capabilities = ["update"] }
path "transit/decrypt/user-data" { capabilities = ["update"] }
path "database/creds/tropis-app" { capabilities = ["read"] }
path "auth/token/renew-self"  { capabilities = ["update"] }
path "auth/token/lookup-self" { capabilities = ["read"] }
POLICY

echo ">>> Policy 'tropis-app' created."

# ── 3. AppRole auth ───────────────────────────────────────────────────────────
# Production pattern: CI/CD injects VAULT_SECRET_ID at deploy time.
# The secret_id is single-use or short-TTL — never stored in code or .env.

vault auth enable approle 2>/dev/null || true

vault write auth/approle/role/tropis-app \
  policies="tropis-app" \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=0 \
  secret_id_num_uses=0

ROLE_ID=$(vault read -field=role_id auth/approle/role/tropis-app/role-id)
SECRET_ID=$(vault write -f -field=secret_id auth/approle/role/tropis-app/secret-id)

echo ">>> AppRole created."

# ── 4. Transit secrets engine (encryption as a service) ──────────────────────
# App sends plaintext → Vault encrypts → returns vault:v1:... ciphertext.
# Encryption key never leaves Vault. Supports key rotation (re-encrypt old data).

vault secrets enable transit 2>/dev/null || true

vault write -f transit/keys/user-data \
  type=aes256-gcm96 \
  exportable=false \
  allow_plaintext_backup=false

echo ">>> Transit engine + 'user-data' key created."

# ── 5. Database secrets engine (dynamic PostgreSQL credentials) ───────────────
# Vault generates a temporary DB user (TTL=1h), revokes it automatically.
# The app never stores the DB password — it leases one fresh each boot.
# Requires PostgreSQL to be reachable at postgres:5432 from within Docker network.

vault secrets enable database 2>/dev/null || true

# Configure the PostgreSQL connection (using the static tropis to create dynamic users)
vault write database/config/tropis-postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="tropis-app" \
  connection_url="postgresql://{{username}}:{{password}}@postgres:5432/tropis?sslmode=disable" \
  username="tropis" \
  password="tropis_dev_password" || echo "WARN: DB secrets engine config failed — PostgreSQL may not be ready. Re-run after postgres starts."

# Create a role that generates temp users with read/write on tropis
vault write database/roles/tropis-app \
  db_name=tropis-postgres \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\"; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"{{name}}\";" \
  revocation_statements="DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="4h" || echo "WARN: DB role creation failed — will retry on next vault-init run."

echo ">>> Database secrets engine configured."

# ── Output ────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Vault initialised!"
echo ""
echo "  Web UI     : http://localhost:8200"
echo "  Root token : dev-root-token  (dev only)"
echo ""
echo "  ── Option A: Static token (simple) ─────────────────"
echo "  Add to apps/backend/.env:"
echo "  VAULT_ADDR=http://localhost:8200"
echo "  VAULT_TOKEN=dev-root-token"
echo "  VAULT_SECRET_PATH=secret/data/tropis"
echo ""
echo "  ── Option B: AppRole (production pattern) ──────────"
echo "  Add to apps/backend/.env:"
echo "  VAULT_ADDR=http://localhost:8200"
echo "  VAULT_ROLE_ID=$ROLE_ID"
echo "  VAULT_SECRET_ID=$SECRET_ID"
echo "  VAULT_SECRET_PATH=secret/data/tropis"
echo "════════════════════════════════════════════════════════"
