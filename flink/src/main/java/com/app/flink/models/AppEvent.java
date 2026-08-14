package com.app.flink.models;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.io.Serializable;

/**
 * Represents a domain event published to Pulsar by the NestJS backend.
 *
 * NestJS side publishes JSON like:
 * {
 *   "eventId":   "uuid",
 *   "eventType": "user.created",
 *   "userId":    "abc123",
 *   "payload":   "{...}",
 *   "timestamp": 1712345678000
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

    @JsonProperty("payload")
    private String payload;

    @JsonProperty("timestamp")
    private long timestamp;

    public AppEvent() {}

    public AppEvent(String eventId, String eventType, String userId, String payload, long timestamp) {
        this.eventId = eventId;
        this.eventType = eventType;
        this.userId = userId;
        this.payload = payload;
        this.timestamp = timestamp;
    }

    public String getEventId()              { return eventId; }
    public void setEventId(String v)        { this.eventId = v; }

    public String getEventType()            { return eventType; }
    public void setEventType(String v)      { this.eventType = v; }

    public String getUserId()               { return userId; }
    public void setUserId(String v)         { this.userId = v; }

    public String getPayload()              { return payload; }
    public void setPayload(String v)        { this.payload = v; }

    public long getTimestamp()              { return timestamp; }
    public void setTimestamp(long v)        { this.timestamp = v; }

    @Override
    public String toString() {
        return "AppEvent{eventId='" + eventId + "', eventType='" + eventType +
               "', userId='" + userId + "', timestamp=" + timestamp + "}";
    }
}
