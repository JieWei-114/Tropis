package com.app.flink.deserializers;

import com.app.flink.models.AppEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.flink.api.common.serialization.DeserializationSchema;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.pulsar.client.api.Schema;
import org.apache.flink.connector.pulsar.source.reader.deserializer.PulsarDeserializationSchema;
import org.apache.flink.util.Collector;
import org.apache.pulsar.client.api.Message;

import java.io.IOException;

/**
 * Deserializes raw Pulsar message bytes (JSON) into AppEvent objects.
 */
public class AppEventDeserializer implements PulsarDeserializationSchema<AppEvent> {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public void deserialize(Message<byte[]> message, Collector<AppEvent> out) throws IOException {
        AppEvent event = MAPPER.readValue(message.getData(), AppEvent.class);
        out.collect(event);
    }

    @Override
    public TypeInformation<AppEvent> getProducedType() {
        return TypeInformation.of(AppEvent.class);
    }
}
