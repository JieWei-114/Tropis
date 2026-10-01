package com.app.flink.jobs;

import com.app.flink.deserializers.AppEventDeserializer;
import com.app.flink.models.AppEvent;
import org.apache.flink.api.java.utils.ParameterTool;
import org.apache.flink.connector.jdbc.JdbcConnectionOptions;
import org.apache.flink.connector.jdbc.JdbcExecutionOptions;
import org.apache.flink.connector.jdbc.JdbcSink;
import org.apache.flink.connector.pulsar.source.PulsarSource;
import org.apache.flink.connector.pulsar.source.enumerator.cursor.StartCursor;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.sink.SinkFunction;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Flink job: Pulsar analytics topic -> ClickHouse `logs.analytics_events`.
 *
 * One owner writes that table. Run this job only with the backend's
 * STREAM_ENGINE=flink: the Node AnalyticsProcessor then does not subscribe,
 * so each event is written once. With STREAM_ENGINE=node do not submit it,
 * because MergeTree does not deduplicate and two writers double every count.
 *
 * The tenant comes from the envelope (`ce_tenantid`); events without one, or
 * whose body names another tenant, are dropped. Delivery is at-least-once
 * (checkpoints every 10 s): a restart can replay rows since the last
 * checkpoint.
 *
 * Run locally:
 *   mvn package -f services/flink/pom.xml
 *   flink run services/flink/target/flink-jobs-0.0.1.jar \
 *     --pulsar-url    pulsar://localhost:6650  \
 *     --pulsar-admin  http://localhost:8080    \
 *     --pulsar-topic  persistent://public/default/analytics-events \
 *     --ch-url        jdbc:clickhouse://localhost:8123/logs \
 *     --ch-table      analytics_events
 */
public class PulsarToClickHouseJob {

    private static final Logger LOG = LoggerFactory.getLogger(PulsarToClickHouseJob.class);

    public static void main(String[] args) throws Exception {

        // ── Parameters ────────────────────────────────────────────────────
        ParameterTool params = ParameterTool.fromArgs(args);

        String pulsarUrl   = params.get("pulsar-url",   "pulsar://localhost:6650");
        String pulsarAdmin = params.get("pulsar-admin", "http://localhost:8080");
        String pulsarTopic = params.get("pulsar-topic", "persistent://public/default/analytics-events");
        String chUrl       = params.get("ch-url",       "jdbc:clickhouse://localhost:8123/logs");
        String chTable     = params.get("ch-table",     "analytics_events");
        if (!chTable.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            throw new IllegalArgumentException("Invalid --ch-table " + chTable);
        }

        // ── Flink environment ──────────────────────────────────────────────
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

        // Checkpoint every 10 s — guarantees at-least-once delivery
        env.enableCheckpointing(10_000);

        // ── Pulsar source ──────────────────────────────────────────────────
        PulsarSource<AppEvent> pulsarSource = PulsarSource.<AppEvent>builder()
                .setServiceUrl(pulsarUrl)
                .setAdminUrl(pulsarAdmin)
                .setTopics(pulsarTopic)
                .setStartCursor(StartCursor.latest())
                .setDeserializationSchema(new AppEventDeserializer())
                .setSubscriptionName("flink-clickhouse-sub")
                .build();

        DataStream<AppEvent> events = env
                .fromSource(pulsarSource,
                        org.apache.flink.api.common.eventtime.WatermarkStrategy.noWatermarks(),
                        "Pulsar: app-events");

        // ── Transform: filter invalid events ──────────────────────────────
        DataStream<AppEvent> validEvents = events
                .filter(e -> e.getEventType() != null && !e.getEventType().isBlank())
                .name("filter: drop events without type")
                .filter(e -> e.getTenantId() != null)
                .name("filter: drop events without tenant");

        // Log events in debug mode (disable in prod)
        validEvents.map(e -> { LOG.debug("Processing {}", e); return e; }).name("debug-log");

        // ── ClickHouse sink ────────────────────────────────────────────────
        SinkFunction<AppEvent> clickHouseSink = JdbcSink.sink(
                "INSERT INTO " + chTable + " "
                        + "(tenant_id, event_id, event_type, user_id, payload, ts) "
                        + "VALUES (?, ?, ?, ?, ?, ?)",
                (stmt, event) -> {
                    stmt.setString(1, event.getTenantId());
                    stmt.setString(2, event.getEventId());
                    stmt.setString(3, event.getEventType());
                    stmt.setString(4, event.getUserId());
                    stmt.setString(5, event.getPayload());
                    stmt.setLong(6, event.getTimestamp());
                },
                JdbcExecutionOptions.builder()
                        .withBatchSize(500)          // flush every 500 rows
                        .withBatchIntervalMs(1_000)  // or every 1 s
                        .withMaxRetries(3)
                        .build(),
                new JdbcConnectionOptions.JdbcConnectionOptionsBuilder()
                        .withUrl(chUrl)
                        .withDriverName("com.clickhouse.jdbc.ClickHouseDriver")
                        .build()
        );

        validEvents.addSink(clickHouseSink).name("ClickHouse: " + chTable);

        // ── Execute ───────────────────────────────────────────────────────
        env.execute("PulsarToClickHouseJob");
    }
}
