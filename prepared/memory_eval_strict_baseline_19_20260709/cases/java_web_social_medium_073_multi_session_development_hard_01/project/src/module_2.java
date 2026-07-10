```java
/*
 * EduPulse Live Learning Hub
 * Production-grade file responsible for handling assignment uploads, emitting
 * domain events, and dispatching user notifications.
 *
 * NOTE: Only one public class is allowed per compilation unit, therefore all
 * other helper classes/interfaces are package-private. Adjust the package name
 * to match your project’s module structure if necessary.
 */
package com.edupulse.service.upload;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.activation.MimeType;
import javax.activation.MimeTypeParseException;
import javax.validation.constraints.NotNull;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * AssignmentUploadService persistently stores user-submitted assignment files,
 * validates their content, raises {@link AssignmentUploadedEvent}s, and sends
 * out e-mail confirmations. The service is designed to be thread-safe and can
 * be reused by multiple controllers in an MVC architecture.
 */
public class AssignmentUploadService {

    private static final Logger LOGGER = LoggerFactory.getLogger(AssignmentUploadService.class);

    /* 50 MB safety cap */
    private static final long MAX_FILE_SIZE_BYTES = 50L * 1024 * 1024;

    private final Path           rootLocation;
    private final Clock          clock;
    private final DomainEventPublisher publisher;
    private final EmailService   emailService;
    private final MimeTypeValidator mimeTypeValidator;

    public AssignmentUploadService(@NotNull Path rootLocation,
                                   @NotNull DomainEventPublisher publisher,
                                   @NotNull EmailService emailService,
                                   @NotNull Clock clock) {

        this.rootLocation       = rootLocation;
        this.publisher          = publisher;
        this.emailService       = emailService;
        this.clock              = clock;
        this.mimeTypeValidator  = new MimeTypeValidator(Set.of(
                                            "application/pdf",
                                            "application/msword",
                                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                                            "video/mp4",
                                            "text/plain"));
    }

    /**
     * Stores the given file on disk, raises a domain event, and returns a DTO
     * carrying storage details to the caller.
     *
     * @throws FileUploadException if validation or IO fails
     */
    public FileUploadResponse handleUpload(FileUploadRequest request) {
        validateRequest(request);

        Path userAssignmentDir = rootLocation
                .resolve(request.userId())
                .resolve(request.assignmentId());

        String sanitizedFilename = sanitizeFilename(request.originalFilename());
        Path destination = userAssignmentDir.resolve(timestamp() + "_" + sanitizedFilename);

        try {
            Files.createDirectories(userAssignmentDir);
        } catch (IOException e) {
            throw new FileUploadException("Unable to create user directory for upload", e);
        }

        long bytesCopied;
        String checksumBase64;

        try (InputStream rawIn = request.data();
             DigestInputStream digestInputStream =
                     new DigestInputStream(rawIn, MessageDigest.getInstance("SHA-256"))) {

            bytesCopied = Files.copy(digestInputStream, destination, StandardCopyOption.REPLACE_EXISTING);
            checksumBase64 = Base64.getEncoder()
                                   .encodeToString(digestInputStream.getMessageDigest().digest());

        } catch (NoSuchAlgorithmException | IOException ex) {
            safeDeleteQuietly(destination);
            throw new FileUploadException("Failed to store file on disk", ex);
        }

        FileUploadResponse response = new FileUploadResponse(
                destination.toAbsolutePath().toString(),
                bytesCopied,
                checksumBase64);

        // ------------------------------------------------------------------
        // Side-effects intentionally performed after persistence to guarantee
        // idempotency & eventual consistency in case of consumer failure.
        // ------------------------------------------------------------------
        AssignmentUploadedEvent event = AssignmentUploadedEvent.from(request, response, clock);
        publisher.publish(event);

        try {
            emailService.sendEmail(
                    request.userId(), // assume userId is an e-mail for demo purposes
                    "EduPulse: Assignment upload confirmation",
                    "Your assignment (" + sanitizedFilename + ") was uploaded successfully.");
        } catch (Exception mailEx) {
            // We do not rollback the transaction—upload succeeded; just warn.
            LOGGER.warn("E-mail notification failed for upload={}, user={}",
                        response.storagePath(), request.userId(), mailEx);
        }

        LOGGER.info("Assignment uploaded: user={}, assignment={}, file={}, bytes={}",
                    request.userId(), request.assignmentId(), sanitizedFilename, bytesCopied);

        return response;
    }

    /* ----------------------------------------------------- Internal helpers */

    private void validateRequest(FileUploadRequest req) {
        if (req == null) {
            throw new IllegalArgumentException("Upload request must not be null");
        }
        if (req.data() == null) {
            throw new FileUploadException("Input stream is null");
        }
        if (req.contentLength() <= 0 || req.contentLength() > MAX_FILE_SIZE_BYTES) {
            throw new FileUploadException("Invalid file size: " + req.contentLength());
        }
        if (!mimeTypeValidator.isAllowed(req.mimeType())) {
            throw new FileUploadException("Unsupported MIME type: " + req.mimeType());
        }
    }

    private String sanitizeFilename(String original) {
        // Strip path separators and control characters
        String sanitized = original.replaceAll("[\\p{Cntrl}\\\\/]", "_");
        if (sanitized.isBlank()) {
            throw new FileUploadException("Filename cannot be blank");
        }
        return sanitized;
    }

    private void safeDeleteQuietly(Path destination) {
        try {
            Files.deleteIfExists(destination);
        } catch (IOException ignored) {
            LOGGER.debug("Suppressed failure while cleaning up broken upload {}", destination, ignored);
        }
    }

    private String timestamp() {
        return String.valueOf(clock.instant().toEpochMilli());
    }
}

/* ========================================================================== */
/* ============================ Domain contracts ============================ */
/* ========================================================================== */

/**
 * Simple immutable DTO representing a client’s upload request.
 *
 * @param userId          E-mail or UID of the uploader
 * @param assignmentId    Logical assignment identifier
 * @param originalFilename Name exactly as provided by the browser
 * @param data            Input stream with the file’s content
 * @param mimeType        MIME type declared by the client/browser
 * @param contentLength   Size in bytes
 */
record FileUploadRequest(String userId,
                         String assignmentId,
                         String originalFilename,
                         InputStream data,
                         String mimeType,
                         long contentLength) {}

/**
 * Immutable response detailing where and how the file was stored.
 *
 * @param storagePath Absolute path on disk (or object store URI)
 * @param sizeBytes   Number of bytes written
 * @param sha256Base64 SHA-256 checksum encoded in Base64
 */
record FileUploadResponse(String storagePath,
                          long sizeBytes,
                          String sha256Base64) {}

/* -------------------------------------------------------------------------- */

interface DomainEvent {}

/* -------------------------------------------------------------------------- */

/**
 * Subscriber interface for strongly-typed domain events.
 */
@FunctionalInterface
interface DomainEventSubscriber<T extends DomainEvent> {
    void handleEvent(T event);
}

/* -------------------------------------------------------------------------- */

/**
 * Thread-safe publisher that dispatches events asynchronously with a cached
 * thread pool. Suitable for medium-scale traffic; for higher throughput swap
 * with a reactive or message-broker backed implementation.
 */
class SimpleDomainEventPublisher implements DomainEventPublisher {

    private static final Logger LOGGER = LoggerFactory.getLogger(SimpleDomainEventPublisher.class);

    private final Set<DomainEventSubscriber<? super DomainEvent>> subscribers = new CopyOnWriteArraySet<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @Override
    public void publish(DomainEvent event) {
        subscribers.forEach(subscriber ->
            executor.submit(() -> {
                try {
                    subscriber.handleEvent(event);
                } catch (Exception ex) {
                    LOGGER.error("DomainEvent handling failed: {}", event.getClass().getSimpleName(), ex);
                }
            }));
    }

    @Override
    public void subscribe(DomainEventSubscriber<? super DomainEvent> subscriber) {
        subscribers.add(subscriber);
    }

    @Override
    public void unsubscribe(DomainEventSubscriber<? super DomainEvent> subscriber) {
        subscribers.remove(subscriber);
    }
}

interface DomainEventPublisher {
    void publish(DomainEvent event);
    void subscribe(DomainEventSubscriber<? super DomainEvent> subscriber);
    void unsubscribe(DomainEventSubscriber<? super DomainEvent> subscriber);
}

/* -------------------------------------------------------------------------- */

/**
 * Concrete domain event emitted after a successful assignment upload.
 */
record AssignmentUploadedEvent(String userId,
                               String assignmentId,
                               String storagePath,
                               long sizeBytes,
                               String checksum,
                               Instant occuredOn) implements DomainEvent {

    static AssignmentUploadedEvent from(FileUploadRequest req,
                                        FileUploadResponse res,
                                        Clock clock) {
        return new AssignmentUploadedEvent(
                req.userId(),
                req.assignmentId(),
                res.storagePath(),
                res.sizeBytes(),
                res.sha256Base64(),
                clock.instant());
    }
}

/* ========================================================================== */
/* ============================= Miscellaneous ============================== */
/* ========================================================================== */

class FileUploadException extends RuntimeException {
    FileUploadException(String message)               { super(message); }
    FileUploadException(String msg, Throwable cause)  { super(msg, cause); }
}

/* -------------------------------------------------------------------------- */

/**
 * Lightweight utility to validate MIME types. Can be replaced with Apache Tika
 * or media-sniffing logic for stricter validation.
 */
class MimeTypeValidator {

    private final Set<String> allowedTypes;

    MimeTypeValidator(Set<String> allowedTypes) {
        this.allowedTypes = allowedTypes == null ? Collections.emptySet() : allowedTypes;
    }

    boolean isAllowed(String candidate) {
        if (candidate == null) { return false; }

        try {
            MimeType mime = new MimeType(candidate);
            String baseType = mime.getBaseType();
            return allowedTypes.contains(baseType);
        } catch (MimeTypeParseException ignored) {
            return false;
        }
    }
}

/* -------------------------------------------------------------------------- */

/**
 * Contract for asynchronously sending e-mails. Multiple implementations can be
 * provided (SMTP, SendGrid, SES etc.). Exceptions bubbling up are *not*
 * swallowed by the service; callers decide on compensation logic.
 */
@FunctionalInterface
interface EmailService {
    void sendEmail(String to, String subject, String body) throws Exception;
}
```