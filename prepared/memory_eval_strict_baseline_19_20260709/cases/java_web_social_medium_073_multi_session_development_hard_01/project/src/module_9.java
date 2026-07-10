```java
package com.edupulse.livelearninghub.assignment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import javax.persistence.*;
import javax.validation.ConstraintViolation;
import javax.validation.ConstraintViolationException;
import javax.validation.Validation;
import javax.validation.Validator;
import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import java.io.IOException;
import java.time.Instant;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * AssignmentUploadService is responsible for orchestrating the entire life-cycle of an assignment
 * upload request: validation, file storage, persistence, event publication, and user notification.
 *
 * <p>This class represents a typical Spring service in a clean architecture setting,
 * decoupled from the web and persistence layers through well-defined ports (interfaces).
 */
@Service
public class AssignmentUploadService {

    private static final Logger LOGGER = LoggerFactory.getLogger(AssignmentUploadService.class);

    private final AssignmentRepository assignmentRepository;
    private final StorageService storageService;
    private final EmailNotificationService emailNotificationService;
    private final DomainEventPublisher eventPublisher;
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    public AssignmentUploadService(
            AssignmentRepository assignmentRepository,
            StorageService storageService,
            EmailNotificationService emailNotificationService,
            DomainEventPublisher eventPublisher
    ) {
        this.assignmentRepository = Objects.requireNonNull(assignmentRepository);
        this.storageService = Objects.requireNonNull(storageService);
        this.emailNotificationService = Objects.requireNonNull(emailNotificationService);
        this.eventPublisher = Objects.requireNonNull(eventPublisher);
    }

    /**
     * Uploads an assignment, persists it, publishes an event, and emails the user.
     *
     * @param request the upload request DTO
     * @return the persisted Assignment entity
     * @throws AssignmentUploadException if anything goes wrong
     */
    @Transactional
    public Assignment uploadAssignment(AssignmentUploadRequest request) {

        validate(request);

        try {
            // 1. Store file in distributed file storage (minio/AWS S3/etc.)
            String storageKey = storageService.store(
                    request.file(),
                    String.format("courses/%d/users/%d/", request.courseId(), request.userId())
            );

            // 2. Persist assignment meta-data
            Assignment assignment = new Assignment(
                    request.userId(),
                    request.courseId(),
                    storageKey,
                    request.originalFilename()
            );
            assignmentRepository.save(assignment);

            // 3. Publish domain event for asynchronous processing
            AssignmentUploadedEvent event = new AssignmentUploadedEvent(
                    assignment.getId(),
                    assignment.getUserId(),
                    assignment.getCourseId(),
                    assignment.getStorageKey()
            );
            eventPublisher.publish(event);

            // 4. Notify user by email (fire-and-forget)
            emailNotificationService.sendAssignmentUploadConfirmation(assignment);

            LOGGER.info("Assignment [{}] successfully uploaded by user [{}]", assignment.getId(), assignment.getUserId());
            return assignment;

        } catch (IOException ex) {
            LOGGER.error("I/O error while uploading assignment for user [{}]", request.userId(), ex);
            throw new AssignmentUploadException("Could not store uploaded file.", ex);
        } catch (Exception ex) {
            LOGGER.error("Unexpected error during assignment upload workflow.", ex);
            throw new AssignmentUploadException("Assignment upload failed.", ex);
        }
    }

    /* --------------------------------------------------- *
     * Private helpers
     * --------------------------------------------------- */

    private void validate(AssignmentUploadRequest request) {
        Set<ConstraintViolation<AssignmentUploadRequest>> violations = validator.validate(request);
        if (!violations.isEmpty()) {
            throw new ConstraintViolationException("Upload request is invalid.", violations);
        }
        if (request.file().isEmpty()) {
            throw new AssignmentUploadException("Uploaded file is empty.");
        }
    }
}

/* ===================================================== *
 * Below are package-private support types that would
 * normally live in their own files/modules. They are
 * colocated here for brevity of the example.
 * ===================================================== */

/**
 * JPA entity representing an assignment submission.
 */
@Entity
@Table(name = "assignments")
class Assignment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private Long userId;

    @Column(nullable = false)
    private Long courseId;

    @Column(nullable = false, unique = true)
    private String storageKey;

    @Column(nullable = false)
    private String originalFilename;

    @Column(nullable = false)
    private Instant uploadedAt;

    protected Assignment() {
        /* For JPA */ }

    public Assignment(Long userId, Long courseId, String storageKey, String originalFilename) {
        this.userId = userId;
        this.courseId = courseId;
        this.storageKey = storageKey;
        this.originalFilename = originalFilename;
        this.uploadedAt = Instant.now();
    }

    public Long getId()                 { return id; }
    public Long getUserId()             { return userId; }
    public Long getCourseId()           { return courseId; }
    public String getStorageKey()       { return storageKey; }
    public String getOriginalFilename() { return originalFilename; }
    public Instant getUploadedAt()      { return uploadedAt; }
}

/**
 * Data Transfer Object representing an upload request coming from a controller.
 */
record AssignmentUploadRequest(
        @NotNull Long userId,
        @NotNull Long courseId,
        @NotNull MultipartFile file,
        @NotBlank String originalFilename
) { }

/**
 * Domain event emitted when an assignment is successfully uploaded.
 */
final class AssignmentUploadedEvent implements DomainEvent {

    private final UUID   eventId      = UUID.randomUUID();
    private final Instant occurredAt  = Instant.now();
    private final Long assignmentId;
    private final Long userId;
    private final Long courseId;
    private final String storageKey;

    AssignmentUploadedEvent(Long assignmentId, Long userId, Long courseId, String storageKey) {
        this.assignmentId = assignmentId;
        this.userId       = userId;
        this.courseId     = courseId;
        this.storageKey   = storageKey;
    }

    /* ------------------- DomainEvent ------------------- */

    @Override public UUID eventId()     { return eventId; }
    @Override public Instant occurredAt() { return occurredAt; }
    @Override public String eventName() { return "assignment.uploaded"; }

    /* ------------------- Getters ----------------------- */

    public Long assignmentId() { return assignmentId; }
    public Long userId()       { return userId; }
    public Long courseId()     { return courseId; }
    public String storageKey() { return storageKey; }
}

/**
 * Repository abstraction to persist Assignment entities.
 * Spring Data will auto-implement this interface at build-time.
 */
interface AssignmentRepository extends org.springframework.data.jpa.repository.JpaRepository<Assignment, Long> { }

/**
 * Port for sending email notifications. An SMTP/Mailgun/Amazon-SES adapter implements this.
 */
interface EmailNotificationService {
    void sendAssignmentUploadConfirmation(Assignment assignment);
}

/**
 * Port for publishing events to the event bus (Kafka/RabbitMQ/etc.).
 */
interface DomainEventPublisher {
    void publish(DomainEvent event);
}

/**
 * Marker interface for domain events.
 */
interface DomainEvent {
    UUID eventId();
    Instant occurredAt();
    String eventName();
}

/**
 * Port for storing files to underlying storage (local FS, S3, MinIO, ...) .
 */
interface StorageService {

    /**
     * Stores {@code file} under {@code pathPrefix} and returns the storage key.
     *
     * @param file       the uploaded file
     * @param pathPrefix the directory/prefix inside the bucket
     * @return storage key for later retrieval
     * @throws IOException on storage errors
     */
    String store(MultipartFile file, String pathPrefix) throws IOException;
}

/**
 * Wrapper for domain-specific errors during the upload workflow.
 */
class AssignmentUploadException extends RuntimeException {
    AssignmentUploadException(String message)               { super(message); }
    AssignmentUploadException(String message, Throwable ex) { super(message, ex); }
}
```