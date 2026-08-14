#!/usr/bin/env bash
# Submit the PulsarToClickHouseJob to the local Flink cluster.
# Usage (from repo root):  bash flink/submit-job.sh
#
# Requirements: Docker running (for infra), Maven OR Docker for the build step.
# The script auto-detects whether mvn is available; falls back to Docker build.

set -euo pipefail

FLINK="http://localhost:8081"
JAR="flink/target/flink-jobs-0.0.1.jar"

PULSAR_URL="pulsar://localhost:6650"
PULSAR_ADMIN="http://localhost:8080"
PULSAR_TOPIC="persistent://public/default/analytics-events"
CH_JDBC="jdbc:clickhouse://localhost:8123/logs"

# ── 1. Build JAR ─────────────────────────────────────────────────────────────

if [ ! -f "$JAR" ]; then
  echo ">>> Building Flink job JAR..."
  if command -v mvn &>/dev/null; then
    mvn clean package -q -f flink/pom.xml -DskipTests
  else
    echo "    mvn not found — building inside Docker (requires internet on first run)"
    docker run --rm \
      -v "$(pwd)/flink":/workspace \
      -w /workspace \
      maven:3.9-eclipse-temurin-11 \
      mvn clean package -q -DskipTests
  fi
  echo ">>> JAR built: $JAR"
fi

# ── 2. Wait for Flink to be ready ────────────────────────────────────────────

echo ">>> Waiting for Flink JobManager at $FLINK ..."
for i in $(seq 1 20); do
  if curl -sf "$FLINK/overview" >/dev/null 2>&1; then
    break
  fi
  echo "    attempt $i/20 — retrying in 3s"
  sleep 3
done
curl -sf "$FLINK/overview" >/dev/null || { echo "ERROR: Flink not reachable at $FLINK"; exit 1; }

# ── 3. Upload JAR ────────────────────────────────────────────────────────────

echo ">>> Uploading JAR to Flink..."
UPLOAD_RESP=$(curl -s -X POST "$FLINK/jars/upload" \
  -H "Expect:" \
  -F "jarfile=@${JAR}")

JAR_ID=$(echo "$UPLOAD_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['filename'].split('/')[-1])" 2>/dev/null \
         || echo "$UPLOAD_RESP" | grep -o '"[^"]*\.jar"' | head -1 | tr -d '"')

[ -z "$JAR_ID" ] && { echo "ERROR: could not parse JAR id from upload response:"; echo "$UPLOAD_RESP"; exit 1; }
echo "    JAR id: $JAR_ID"

# ── 4. Run the job ───────────────────────────────────────────────────────────

echo ">>> Submitting job..."
RUN_RESP=$(curl -s -X POST "$FLINK/jars/${JAR_ID}/run" \
  -H "Content-Type: application/json" \
  -d "{
    \"entryClass\": \"com.app.flink.jobs.PulsarToClickHouseJob\",
    \"programArgs\": \"--pulsar-url ${PULSAR_URL} --pulsar-admin ${PULSAR_ADMIN} --pulsar-topic ${PULSAR_TOPIC} --ch-url ${CH_JDBC}\"
  }")

echo "$RUN_RESP"
JOB_ID=$(echo "$RUN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jobid',''))" 2>/dev/null || true)

if [ -n "$JOB_ID" ]; then
  echo ""
  echo "Job submitted — ID: $JOB_ID"
  echo "Monitor: $FLINK/#/jobs/$JOB_ID"
else
  echo ""
  echo "Check $FLINK for job status"
fi
