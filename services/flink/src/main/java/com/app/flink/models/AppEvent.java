package com.app.flink.models;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.io.Serializable;

/**
 * One message from the analytics topic. The body is the event data the
 * outbox relay publishes (CloudEvents binary mode; the envelope attributes
 * travel as ce_* message properties):
 * {
 *   "eventId":   "<domain event id>",
 *   "eventType": "page_view",
 *   "userId":    "...",
 *   "metadata":  { ... },
 *   "timestamp": 1712345678000,
 *   "tenantId":  "acme"
 * }
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class AppEvent implements Serializable {

    @JsonProperty("eventId")
    private String eventId;

    @JsonProperty("eventType")
    private String eventType;

    @JsonProperty("userId")
    private String userId;

    @JsonProperty("tenantId")
    private String tenantId;

    @JsonProperty("metadata")
    private Object metadata;

    @JsonProperty("timestamp")
    private long timestamp;

    /** Tenant from the envelope (`ce_tenantid`); never read from the body. */
    @JsonIgnore
    private String envelopeTenant;

    public AppEvent() {}

    /** The domain event id. */
    public String getEventId() {
        return eventId;
    }

    public String getEventType() {
        return eventType;
    }

    public String getUserId() {
        return userId != null ? userId : "";
    }

    /**
     * Owning tenant, taken from the envelope as the Node consumers do. Null
     * when the envelope names none or the body names a different tenant; the
     * job drops such events, since there is no default tenant.
     */
    public String getTenantId() {
        if (envelopeTenant == null || envelopeTenant.isBlank()) return null;
        if (tenantId != null && !tenantId.isBlank() && !tenantId.equals(envelopeTenant)) return null;
        return envelopeTenant;
    }

    /** The event's own metadata, serialized for the ClickHouse String column. */
    public String getPayload() {
        if (metadata == null) return "{}";
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper()
                    .writeValueAsString(metadata);
        } catch (Exception e) {
            return "{}";
        }
    }

    /** The event's own timestamp. */
    public long getTimestamp() {
        return timestamp;
    }

    // Setters kept for Jackson.
    public void setEventId(String v)     { this.eventId = v; }
    public void setEventType(String v)   { this.eventType = v; }
    public void setUserId(String v)      { this.userId = v; }
    public void setTenantId(String v)    { this.tenantId = v; }
    public void setMetadata(Object v)    { this.metadata = v; }
    public void setTimestamp(long v)     { this.timestamp = v; }
    public void setEnvelopeTenant(String v) { this.envelopeTenant = v; }

    @Override
    public String toString() {
        return "AppEvent{eventId='" + getEventId() + "', eventType='" + getEventType() +
               "', tenantId='" + getTenantId() + "', timestamp=" + getTimestamp() + "}";
    }
}
