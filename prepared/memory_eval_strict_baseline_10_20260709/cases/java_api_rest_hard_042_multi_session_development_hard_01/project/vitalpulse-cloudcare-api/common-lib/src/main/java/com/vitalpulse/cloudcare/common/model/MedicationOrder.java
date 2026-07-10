package com.vitalpulse.cloudcare.common.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonValue;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.annotation.JsonPOJOBuilder;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbConvertedBy;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbIgnore;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;

import javax.validation.ConstraintViolation;
import javax.validation.Validation;
import javax.validation.Validator;
import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Positive;
import java.io.Serial;
import java.io.Serializable;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;

/**
 * MedicationOrder is the canonical domain entity that represents a physician's instruction
 * for administering medication to a patient.  It is designed to be:
 *
 *  • JSON serialisable (Jackson)
 *  • Persistable to DynamoDB (AWS SDK v2 Enhanced Client)
 *  • Validatable (Bean Validation 2.0 / JSR-380)
 *  • Immutable after construction (Builder pattern)
 *
 * NOTE: This class purposefully keeps medication-specific ordinals (e.g. dose unit)
 * as simple strings to remain agnostic of the chosen coding system (RxNorm, UCUM, etc.).
 */
@DynamoDbBean
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonDeserialize(builder = MedicationOrder.Builder.class)
public final class MedicationOrder implements Serializable {

    @Serial
    private static final long serialVersionUID = 1622023041101L;

    // -------------------------------------------------------------------------
    // Fields (all private & final to guarantee immutability)
    // -------------------------------------------------------------------------
    private final String orderId;
    private final String patientId;
    private final String medicationCode;
    private final String medicationName;
    private final BigDecimal doseAmount;
    private final String doseUnit;
    private final String dosageInstruction; // free-text instruction
    private final Instant startDate;
    private final Instant endDate;
    private final OrderStatus status;
    private final String prescriberUserId;
    private final Integer numberOfRepeatsAllowed;
    private final Integer numberOfRepeatsRemaining;
    private final Map<String, String> extensions;
    private final Instant createdAt;
    private final Instant lastModifiedAt;

    // -------------------------------------------------------------------------
    // Constructor (package-private, used by Builder)
    // -------------------------------------------------------------------------
    MedicationOrder(Builder b) {
        this.orderId                    = b.orderId;
        this.patientId                  = b.patientId;
        this.medicationCode             = b.medicationCode;
        this.medicationName             = b.medicationName;
        this.doseAmount                 = b.doseAmount;
        this.doseUnit                   = b.doseUnit;
        this.dosageInstruction          = b.dosageInstruction;
        this.startDate                  = b.startDate;
        this.endDate                    = b.endDate;
        this.status                     = b.status;
        this.prescriberUserId           = b.prescriberUserId;
        this.numberOfRepeatsAllowed     = b.numberOfRepeatsAllowed;
        this.numberOfRepeatsRemaining   = b.numberOfRepeatsRemaining;
        this.extensions                 = b.extensions == null ? null :
                                           Collections.unmodifiableMap(new HashMap<>(b.extensions));
        this.createdAt                  = b.createdAt;
        this.lastModifiedAt             = b.lastModifiedAt;
    }

    // -------------------------------------------------------------------------
    // Partition Key for DynamoDB
    // -------------------------------------------------------------------------
    @DynamoDbPartitionKey
    public String getOrderId() {
        return orderId;
    }

    // -------------------------------------------------------------------------
    // Getters (required by Jackson & DynamoDB mappers)
    // -------------------------------------------------------------------------
    public String getPatientId() {
        return patientId;
    }

    public String getMedicationCode() {
        return medicationCode;
    }

    public String getMedicationName() {
        return medicationName;
    }

    public BigDecimal getDoseAmount() {
        return doseAmount;
    }

    public String getDoseUnit() {
        return doseUnit;
    }

    public String getDosageInstruction() {
        return dosageInstruction;
    }

    public Instant getStartDate() {
        return startDate;
    }

    public Instant getEndDate() {
        return endDate;
    }

    public OrderStatus getStatus() {
        return status;
    }

    public String getPrescriberUserId() {
        return prescriberUserId;
    }

    public Integer getNumberOfRepeatsAllowed() {
        return numberOfRepeatsAllowed;
    }

    public Integer getNumberOfRepeatsRemaining() {
        return numberOfRepeatsRemaining;
    }

    public Map<String, String> getExtensions() {
        return extensions;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getLastModifiedAt() {
        return lastModifiedAt;
    }

    // -------------------------------------------------------------------------
    // Domain Logic
    // -------------------------------------------------------------------------

    /**
     * Returns true if the order can still be administered at the provided point in time.
     */
    @DynamoDbIgnore
    public boolean isActiveAt(Instant pointInTime) {
        Objects.requireNonNull(pointInTime, "pointInTime must not be null");
        if (status != OrderStatus.ACTIVE) return false;
        boolean afterStart = startDate == null || !pointInTime.isBefore(startDate);
        boolean beforeEnd  = endDate   == null || !pointInTime.isAfter(endDate);
        return afterStart && beforeEnd;
    }

    /**
     * Returns true if the order has no repeats remaining.
     */
    @DynamoDbIgnore
    public boolean isDepleted() {
        return numberOfRepeatsRemaining != null && numberOfRepeatsRemaining <= 0;
    }

    // -------------------------------------------------------------------------
    // Builder
    // -------------------------------------------------------------------------
    @JsonPOJOBuilder(withPrefix = "set")
    public static final class Builder {

        private static final Validator VALIDATOR = Validation.buildDefaultValidatorFactory().getValidator();

        private String orderId;
        private String patientId;
        private String medicationCode;
        private String medicationName;
        private BigDecimal doseAmount;
        private String doseUnit;
        private String dosageInstruction;
        private Instant startDate;
        private Instant endDate;
        private OrderStatus status = OrderStatus.PLANNED;
        private String prescriberUserId;
        private Integer numberOfRepeatsAllowed;
        private Integer numberOfRepeatsRemaining;
        private Map<String, String> extensions;
        private Instant createdAt;
        private Instant lastModifiedAt;

        // ---------------------------------------------------------------------
        // Builder setters
        // ---------------------------------------------------------------------
        public Builder setOrderId(String orderId) {
            this.orderId = orderId;
            return this;
        }

        public Builder setPatientId(String patientId) {
            this.patientId = patientId;
            return this;
        }

        public Builder setMedicationCode(String medicationCode) {
            this.medicationCode = medicationCode;
            return this;
        }

        public Builder setMedicationName(String medicationName) {
            this.medicationName = medicationName;
            return this;
        }

        public Builder setDoseAmount(BigDecimal doseAmount) {
            this.doseAmount = doseAmount;
            return this;
        }

        public Builder setDoseUnit(String doseUnit) {
            this.doseUnit = doseUnit;
            return this;
        }

        public Builder setDosageInstruction(String dosageInstruction) {
            this.dosageInstruction = dosageInstruction;
            return this;
        }

        public Builder setStartDate(Instant startDate) {
            this.startDate = startDate;
            return this;
        }

        public Builder setEndDate(Instant endDate) {
            this.endDate = endDate;
            return this;
        }

        public Builder setStatus(OrderStatus status) {
            this.status = status == null ? OrderStatus.PLANNED : status;
            return this;
        }

        public Builder setPrescriberUserId(String prescriberUserId) {
            this.prescriberUserId = prescriberUserId;
            return this;
        }

        public Builder setNumberOfRepeatsAllowed(Integer numberOfRepeatsAllowed) {
            this.numberOfRepeatsAllowed = numberOfRepeatsAllowed;
            return this;
        }

        public Builder setNumberOfRepeatsRemaining(Integer numberOfRepeatsRemaining) {
            this.numberOfRepeatsRemaining = numberOfRepeatsRemaining;
            return this;
        }

        public Builder setExtensions(Map<String, String> extensions) {
            this.extensions = extensions;
            return this;
        }

        public Builder setCreatedAt(Instant createdAt) {
            this.createdAt = createdAt;
            return this;
        }

        public Builder setLastModifiedAt(Instant lastModifiedAt) {
            this.lastModifiedAt = lastModifiedAt;
            return this;
        }

        // ---------------------------------------------------------------------
        // Build operation
        // ---------------------------------------------------------------------
        public MedicationOrder build() {
            applyDefaults();
            validate();
            return new MedicationOrder(this);
        }

        private void applyDefaults() {
            if (orderId == null || orderId.isBlank()) {
                orderId = UUID.randomUUID().toString();
            }
            if (createdAt == null) {
                createdAt = Instant.now();
            }
            if (lastModifiedAt == null) {
                lastModifiedAt = createdAt;
            }
            if (numberOfRepeatsRemaining == null && numberOfRepeatsAllowed != null) {
                numberOfRepeatsRemaining = numberOfRepeatsAllowed;
            }
        }

        private void validate() {
            // Bean validation
            Set<ConstraintViolation<Builder>> violations = VALIDATOR.validate(this);
            if (!violations.isEmpty()) {
                StringBuilder sb = new StringBuilder("MedicationOrder validation failed:");
                for (ConstraintViolation<?> violation : violations) {
                    sb.append(System.lineSeparator())
                      .append(" • ")
                      .append(violation.getPropertyPath())
                      .append(' ')
                      .append(violation.getMessage());
                }
                throw new IllegalStateException(sb.toString());
            }

            // Domain specific validations
            if (endDate != null && startDate != null && endDate.isBefore(startDate)) {
                throw new IllegalStateException("endDate must not be before startDate");
            }
            if (numberOfRepeatsRemaining != null && numberOfRepeatsAllowed != null
                    && numberOfRepeatsRemaining > numberOfRepeatsAllowed) {
                throw new IllegalStateException("numberOfRepeatsRemaining cannot exceed numberOfRepeatsAllowed");
            }
        }

        // ---------------------------------------------------------------------
        // Bean Validation Constraint Definitions
        // ---------------------------------------------------------------------
        @NotBlank(message = "patientId must not be blank")
        public String getPatientId() { return patientId; }
        @NotBlank(message = "medicationCode must not be blank")
        public String getMedicationCode() { return medicationCode; }
        @NotBlank(message = "medicationName must not be blank")
        public String getMedicationName() { return medicationName; }
        @NotNull(message = "doseAmount must not be null")
        @Positive(message = "doseAmount must be positive")
        public BigDecimal getDoseAmount() { return doseAmount; }
        @NotBlank(message = "doseUnit must not be blank")
        public String getDoseUnit() { return doseUnit; }
        @NotBlank(message = "prescriberUserId must not be blank")
        public String getPrescriberUserId() { return prescriberUserId; }
    }

    // -------------------------------------------------------------------------
    // Enum definitions
    // -------------------------------------------------------------------------
    public enum OrderStatus {
        PLANNED,
        ACTIVE,
        COMPLETED,
        CANCELLED,
        ENTERED_IN_ERROR;

        @JsonCreator
        public static OrderStatus fromValue(String value) {
            for (OrderStatus s : values()) {
                if (s.name().equalsIgnoreCase(value)) {
                    return s;
                }
            }
            throw new IllegalArgumentException("Unknown OrderStatus: " + value);
        }

        @JsonValue
        public String toValue() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    // -------------------------------------------------------------------------
    // Object overrides
    // -------------------------------------------------------------------------

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof MedicationOrder that)) return false;
        return Objects.equals(orderId, that.orderId);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(orderId);
    }

    @Override
    public String toString() {
        return "MedicationOrder{" +
               "orderId='" + orderId + '\'' +
               ", patientId='" + patientId + '\'' +
               ", medicationCode='" + medicationCode + '\'' +
               ", medicationName='" + medicationName + '\'' +
               ", doseAmount=" + doseAmount +
               ", doseUnit='" + doseUnit + '\'' +
               ", status=" + status +
               '}';
    }
}