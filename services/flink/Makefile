JAR          := target/flink-jobs-0.0.1.jar
FLINK        := http://localhost:8081
PULSAR_URL   := pulsar://localhost:6650
PULSAR_ADMIN := http://localhost:8080
PULSAR_TOPIC := persistent://public/default/analytics-events
CH_JDBC      := jdbc:clickhouse://localhost:8123/logs
CH_TABLE     := analytics_events
JOB          ?= PulsarToClickHouseJob
ARGS         ?= --pulsar-url $(PULSAR_URL) --pulsar-admin $(PULSAR_ADMIN) --pulsar-topic $(PULSAR_TOPIC) --ch-url $(CH_JDBC) --ch-table $(CH_TABLE)

.PHONY: build submit logs

## Build the fat JAR
build:
	mvn clean package -q -f pom.xml

## Submit one job (JOB=<class in jobs/>, ARGS=<program args>) to the local Flink cluster; builds first
submit: build
	curl -s -X POST $(FLINK)/jars/upload \
	  -H "Expect:" \
	  -F "jarfile=@$(JAR)" \
	  | python3 -c "import sys,json; print(json.load(sys.stdin)['filename'])" \
	  | xargs -I{} curl -s -X POST \
	      "$(FLINK)/jars/{}/run" \
	      -H "Content-Type: application/json" \
	      -d '{"entryClass":"com.app.flink.jobs.$(JOB)","programArgs":"$(ARGS)"}'

## Tail Flink TaskManager logs
logs:
	docker logs -f tropis_flink_tm
