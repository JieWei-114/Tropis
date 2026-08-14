JAR          := target/flink-jobs-0.0.1.jar
FLINK        := http://localhost:8081
PULSAR_URL   := pulsar://localhost:6650
PULSAR_ADMIN := http://localhost:8080
PULSAR_TOPIC := persistent://public/default/analytics-events
CH_JDBC      := jdbc:clickhouse://localhost:8123/logs

.PHONY: build submit init-ch logs

## Build the fat JAR
build:
	mvn clean package -q -f pom.xml

## Create ClickHouse table (run once before submitting the job)
init-ch:
	docker exec -i tropis_clickhouse \
	  clickhouse-client < sql/init-clickhouse.sql

## Submit job to local Flink cluster (builds first)
submit: build
	curl -s -X POST $(FLINK)/jars/upload \
	  -H "Expect:" \
	  -F "jarfile=@$(JAR)" \
	  | python3 -c "import sys,json; print(json.load(sys.stdin)['filename'])" \
	  | xargs -I{} curl -s -X POST \
	      "$(FLINK)/jars/{}/run" \
	      -H "Content-Type: application/json" \
	      -d '{"entryClass":"com.app.flink.jobs.PulsarToClickHouseJob","programArgs":"--pulsar-url $(PULSAR_URL) --pulsar-admin $(PULSAR_ADMIN) --pulsar-topic $(PULSAR_TOPIC) --ch-url $(CH_JDBC)"}'

## Tail Flink TaskManager logs
logs:
	docker logs -f tropis_flink_tm
