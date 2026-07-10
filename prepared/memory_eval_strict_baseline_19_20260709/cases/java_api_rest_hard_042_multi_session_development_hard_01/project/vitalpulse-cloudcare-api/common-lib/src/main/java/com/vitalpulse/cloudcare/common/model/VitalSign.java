package com.vitalpulse.cloudcare.common.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;

import javax.validation.constraints.NotNull;
import javax.validation.constraints.Positive;
import java.io.Serial;
import java.io.Serializable;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Domain model representing a single Vital Sign measurement.
 * <p>
 *  • Immutable<br/>
 *  • JSON-serializable via Jackson<br/>
 *  • Bean-validated<br/>
 *  • Builder for ergonomic construction<br/>
 * </p>
 *
 * The model purposefully embraces common FHIR properties (value, unit, code)
 * while remaining cloud-storage agnostic.
 */
@JsonDeserialize(builder = VitalSign.Builder.class)
public final class VitalSign implements Serializable {

    @Serial
    private static final long serialVersionUID = 8141440763091449029L;

    // -----------------------------------------------------------------------
    // Core Fields
    // -----------------------------------------------------------------------

    /** Unique identifier of the VitalSign record. UUID (RFC-4122). */
    private final UUID id;

    /** Logical id of the patient (EHR/FHIR logical id or hashed MRN). */
    private final String patientId;

    /** The type of vital sign measured (SpO2, HR, BP, etc.). */
    private final VitalType type;

    /** Numeric result of the measurement. */
    private final BigDecimal value;

    /** UCUM unit of the measurement, e.g. "bpm", "%" */
    private final String unit;

    /** Time when the measurement was captured at the edge device. */
    private final Instant timestamp;

    /** Device identifier (UDI, serial number, or vendor id). */
    private final String deviceId;

    /** Anatomical site of measurement (e.g. "wrist", "left_arm"). */
    private final String measurementSite;

    /**
     * Arbitrary name/value pairs stored alongside the vital sign, such as
     * firmware version, battery level, or calibration coefficients.
     */
    private final Map<String, Object> metadata;

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    private VitalSign(Builder builder) {
        this.id = builder.id != null ? builder.id : UUID.randomUUID();
        this.patientId = Objects.requireNonNull(builder.patientId, "patientId must not be null");
        this.type = Objects.requireNonNull(builder.type, "type must not be null");
        this.value = Objects.requireNonNull(builder.value, "value must not be null");
        this.unit = Objects.requireNonNull(builder.unit, "unit must not be null");
        this.timestamp = Objects.requireNonNull(builder.timestamp, "timestamp must not be null");
        this.deviceId = builder.deviceId;
        this.measurementSite = builder.measurementSite;
        this.metadata = builder.metadata != null
                ? Collections.unmodifiableMap(builder.metadata)
                : Collections.emptyMap();
    }

    // -----------------------------------------------------------------------
    // Getters (Jackson/Java-Bean style)
    // -----------------------------------------------------------------------

    @NotNull
    public UUID getId() {
        return id;
    }

    @NotNull
    public String getPatientId() {
        return patientId;
    }

    @NotNull
    public VitalType getType() {
        return type;
    }

    @NotNull
    @Positive
    public BigDecimal getValue() {
        return value;
    }

    @NotNull
    public String getUnit() {
        return unit;
    }

    @NotNull
    public Instant getTimestamp() {
        return timestamp;
    }

    public String getDeviceId() {
        return deviceId;
    }

    public String getMeasurementSite() {
        return measurementSite;
    }

    /**
     * Returns an unmodifiable view of additional metadata.
     */
    public Map<String, Object> getMetadata() {
        return metadata;
    }

    // -----------------------------------------------------------------------
    // Convenience
    // -----------------------------------------------------------------------

    /**
     * Returns <code>true</code> if the vital value is within the inclusive range [min, max].
     * This method is often called by decision-support rules.
     */
    @JsonIgnore
    public boolean isWithinRange(BigDecimal min, BigDecimal max) {
        Objects.requireNonNull(min, "min must not be null");
        Objects.requireNonNull(max, "max must not be null");
        return value.compareTo(min) >= 0 && value.compareTo(max) <= 0;
    }

    // -----------------------------------------------------------------------
    // Builder
    // -----------------------------------------------------------------------

    public static Builder builder() {
        return new Builder();
    }

    /**
     * Builder implementing Jackson’s @JsonCreator to enable
     * round-trip JSON deserialization using the same validation logic.
     */
    public static final class Builder {

        private UUID id;
        private String patientId;
        private VitalType type;
        private BigDecimal value;
        private String unit;
        private Instant timestamp;
        private String deviceId;
        private String measurementSite;
        private Map<String, Object> metadata;

        public Builder id(UUID id) {
            this.id = id;
            return this;
        }

        @JsonProperty("patientId")
        public Builder patientId(String patientId) {
            this.patientId = patientId;
            return this;
        }

        @JsonProperty("type")
        public Builder type(VitalType type) {
            this.type = type;
            return this;
        }

        @JsonProperty("value")
        public Builder value(BigDecimal value) {
            this.value = value;
            return this;
        }

        @JsonProperty("unit")
        public Builder unit(String unit) {
            this.unit = unit;
            return this;
        }

        @JsonProperty("timestamp")
        public Builder timestamp(Instant timestamp) {
            this.timestamp = timestamp;
            return this;
        }

        @JsonProperty("deviceId")
        public Builder deviceId(String deviceId) {
            this.deviceId = deviceId;
            return this;
        }

        @JsonProperty("measurementSite")
        public Builder measurementSite(String measurementSite) {
            this.measurementSite = measurementSite;
            return this;
        }

        @JsonProperty("metadata")
        public Builder metadata(Map<String, Object> metadata) {
            this.metadata = metadata;
            return this;
        }

        /**
         * Jackson entrypoint for deserialization.
         */
        @JsonCreator
        static Builder create() {
            return new Builder();
        }

        public VitalSign build() {
            return new VitalSign(this);
        }
    }

    // -----------------------------------------------------------------------
    // Enum
    // -----------------------------------------------------------------------

    /**
     * High-level categorisation of vital signs. The enum intentionally mirrors
     * common LOINC/FHIR codes without committing to a specific code system.
     */
    public enum VitalType {
        HEART_RATE("HR"),
        RESPIRATORY_RATE("RR"),
        BLOOD_PRESSURE_SYSTOLIC("BP_SYS"),
        BLOOD_PRESSURE_DIASTOLIC("BP_DIA"),
        OXYGEN_SATURATION("SpO2"),
        BODY_TEMPERATURE("TEMP");

        private final String code;

        VitalType(String code) {
            this.code = code;
        }

        public String getCode() {
            return code;
        }
    }

    // -----------------------------------------------------------------------
    // Object overrides
    // -----------------------------------------------------------------------

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof VitalSign that)) return false;
        return id.equals(that.id) &&
               patientId.equals(that.patientId) &&
               type == that.type &&
               value.compareTo(that.value) == 0 &&
               unit.equals(that.unit) &&
               timestamp.equals(that.timestamp) &&
               Objects.equals(deviceId, that.deviceId) &&
               Objects.equals(measurementSite, that.measurementSite) &&
               metadata.equals(that.metadata);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id, patientId, type, value, unit, timestamp, deviceId, measurementSite, metadata);
    }

    @Override
    public String toString() {
        return "VitalSign{" +
                "id=" + id +
                ", patientId='" + patientId + '\'' +
                ", type=" + type +
                ", value=" + value +
                ", unit='" + unit + '\'' +
                ", timestamp=" + timestamp +
                ", deviceId='" + deviceId + '\'' +
                ", measurementSite='" + measurementSite + '\'' +
                ", metadata=" + metadata +
                '}';
    }
}