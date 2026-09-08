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
 * Flink job: Pulsar → (filter) → ClickHouse
 *
 * What it does:
 *  1. Consumes AppEvent messages from Pulsar topic "persistent://public/default/analytics-events"
 *     (same topic that NestJS AnalyticsService publishes to)
 *  2. Uses a DIFFERENT subscription name ("flink-clickhouse-sub") than AnalyticsProcessor
 *     ("analytics-processor-sub") — both consumers receive every message independently.
 *  3. Filters out any events missing an eventType
 *  4. Writes every event to ClickHouse table `logs.analytics_events_flink`
 *     in micro-batches
 *
 * WHY ITS OWN TABLE. `logs.analytics_events` is written by AnalyticsProcessor
 * and read by the console. This job's subscription receives every message
 * independently and MergeTree does not deduplicate, so writing there would
 * double every count the dashboard shows whenever both run. A separate table
 * makes the job safe to submit at any time; compare the two tables to see that
 * they agree.
 *
 * Rows carry `tenant_id`, resolved from the envelope payload (see AppEvent).
 * It leads the table's sort key, so an unresolved value files the event under
 * the default tenant and makes it invisible to a per-tenant query.
 *
 * Run locally:
 *   mvn package -f flink/pom.xml
 *   flink run flink/target/flink-jobs-0.0.1.jar \
 *     --pulsar-url    pulsar://localhost:6650  \
 *     --pulsar-admin  http://localhost:8080    \
 *     --pulsar-topic  persistent://public/default/analytics-events \
 *     --ch-url        jdbc:clickhouse://localhost:8123/logs
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
                .name("filter: drop events without type");

        // Log events in debug mode (disable in prod)
        validEvents.map(e -> { LOG.debug("Processing {}", e); return e; }).name("debug-log");

        // ── ClickHouse sink ────────────────────────────────────────────────
        SinkFunction<AppEvent> clickHouseSink = JdbcSink.sink(
                "INSERT INTO analytics_events_flink "
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

        validEvents.addSink(clickHouseSink).name("ClickHouse: events (flink)");

        // ── Execute ───────────────────────────────────────────────────────
        env.execute("PulsarToClickHouseJob");
    }
}
