package com.app.flink.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.io.Serializable;
import java.util.Map;

/**
 * One message from the analytics topic, as published by the NestJS outbox relay.
 *
 * The relay publishes an ENVELOPE, not the event itself:
 * {
 *   "eventId":     "<outbox row id>",      // NOT the event's own id
 *   "eventType":   "page_view",
 *   "aggregateId": "<domain event id>",
 *   "payload":     { "eventId", "eventType", "userId", "metadata",
 *                    "timestamp", "tenantId" },
 *   "timestamp":   1712345678000            // relay publish time
 * }
 *
 * The domain fields live under `payload`; the top level carries the outbox
 * row's id and the relay's clock instead. The accessors below resolve the
 * nested values, falling back to the top level so a direct publish (no outbox)
 * still works.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AppEvent implements Serializable {

    /** Tenant used when a message carries none; the column has no null form. */
    public static final String DEFAULT_TENANT = "default";

    @JsonProperty("eventId")
    private String envelopeEventId;

    @JsonProperty("eventType")
    private String eventType;

    @JsonProperty("aggregateId")
    private String aggregateId;

    @JsonProperty("payload")
    private Map<String, Object> payload;

    @JsonProperty("timestamp")
    private long envelopeTimestamp;

    public AppEvent() {}

    private Object nested(String key) {
        return payload == null ? null : payload.get(key);
    }

    private String nestedString(String key) {
        Object v = nested(key);
        return v == null ? null : String.valueOf(v);
    }

    /** The DOMAIN event id: the envelope's own id identifies the outbox row. */
    public String getEventId() {
        String nestedId = nestedString("eventId");
        if (nestedId != null) return nestedId;
        return aggregateId != null ? aggregateId : envelopeEventId;
    }

    public String getEventType() {
        String nestedType = nestedString("eventType");
        return nestedType != null ? nestedType : eventType;
    }

    public String getUserId() {
        String userId = nestedString("userId");
        return userId != null ? userId : "";
    }

    /** Owning tenant — leads the ClickHouse table's sort key. */
    public String getTenantId() {
        String tenantId = nestedString("tenantId");
        return tenantId != null && !tenantId.isBlank() ? tenantId : DEFAULT_TENANT;
    }

    /** The event's own metadata, serialized for the ClickHouse String column. */
    public String getPayload() {
        Object metadata = nested("metadata");
        if (metadata == null) return "{}";
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper()
                    .writeValueAsString(metadata);
        } catch (Exception e) {
            return "{}";
        }
    }

    /** The event's own timestamp, not the relay's publish time. */
    public long getTimestamp() {
        Object ts = nested("timestamp");
        if (ts instanceof Number) return ((Number) ts).longValue();
        return envelopeTimestamp;
    }

    // Setters kept for Jackson.
    public void setEventId(String v)     { this.envelopeEventId = v; }
    public void setEventType(String v)   { this.eventType = v; }
    public void setAggregateId(String v) { this.aggregateId = v; }
    public void setPayload(Map<String, Object> v) { this.payload = v; }
    public void setTimestamp(long v)     { this.envelopeTimestamp = v; }

    @Override
    public String toString() {
        return "AppEvent{eventId='" + getEventId() + "', eventType='" + getEventType() +
               "', tenantId='" + getTenantId() + "', timestamp=" + getTimestamp() + "}";
    }
}
