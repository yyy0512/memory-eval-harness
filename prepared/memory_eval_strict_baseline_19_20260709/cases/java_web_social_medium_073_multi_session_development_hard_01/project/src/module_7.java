```java
package com.edupulse.files;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Production–grade service that stores uploaded files in a local/remote
 * volume, persists metadata, and emits a {@link FileUploadedEvent} so that
 * other bounded contexts ( e.g. email-notifications, progress analytics)
 * can react asynchronously.
 *
 * Although this implementation stores files on the local file-system and
 * uses an in-memory repository, both collaborators can be replaced with
 * cloud-backed implementations (S3, Azure Blob) and a true JPA repository
 * without changing the public contract.
 *
 * Thread-safe ✦ Non-blocking event dispatch ✦ Robust error handling.
 */
public class FileUploadService {

    private static final Logger LOG = Logger.getLogger(FileUploadService.class.getName());

    /* 50 MB hard limit prevents DOS-style oversized uploads. */
    private static final long MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

    private static final Set<String> ALLOWED_MIME_TYPES = Set.of(
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "image/png",
            "image/jpeg",
            "video/mp4",
            "text/plain"
    );

    private final Path rootDirectory;
    private final FileRepository repository;
    private final EventPublisher eventPublisher;

    /**
     * Constructs a new service instance.
     *
     * @param rootDirectory  the absolute directory under which files are stored
     * @param repository     persistence mechanism for {@link FileMetadata}
     * @param eventPublisher async publisher for domain events
     *
     * @throws IOException if the root directory cannot be created
     */
    public FileUploadService(Path rootDirectory,
                             FileRepository repository,
                             EventPublisher eventPublisher) throws IOException {

        Objects.requireNonNull(rootDirectory, "rootDirectory");
        Objects.requireNonNull(repository, "repository");
        Objects.requireNonNull(eventPublisher, "eventPublisher");

        this.rootDirectory   = Files.createDirectories(rootDirectory);
        this.repository      = repository;
        this.eventPublisher  = eventPublisher;
    }

    /**
     * Performs validation, persists file and metadata, and emits a domain
     * event on success.
     *
     * @param content          stream of file bytes
     * @param originalFilename user-supplied file name
     * @param mimeType         user-supplied or server-detected mime-type
     * @param uploaderUserId   the id of the user performing the upload
     *
     * @return immutable response describing the stored artifact
     *
     * @throws FileUploadException for validation or I/O failures
     */
    public UploadedFileResponse handleUpload(InputStream content,
                                             String      originalFilename,
                                             String      mimeType,
                                             String      uploaderUserId) throws FileUploadException {

        validate(originalFilename, mimeType, uploaderUserId);

        String fileExtension = resolveExtension(originalFilename);
        String storageFilename = UUID.randomUUID() + fileExtension;
        Path   userDir         = rootDirectory.resolve(uploaderUserId);
        Path   target          = userDir.resolve(storageFilename);

        try {
            Files.createDirectories(userDir);

            /* Copy with bounded buffer to prevent storing >MAX_FILE_SIZE_BYTES */
            long bytesCopied = Files.copy(
                    new BoundedInputStream(content, MAX_FILE_SIZE_BYTES),
                    target,
                    StandardCopyOption.REPLACE_EXISTING
            );

            FileMetadata metadata = new FileMetadata(
                    UUID.randomUUID(),
                    originalFilename,
                    mimeType,
                    target.toAbsolutePath().toString(),
                    bytesCopied,
                    uploaderUserId,
                    Instant.now()
            );

            repository.save(metadata);
            eventPublisher.publish(new FileUploadedEvent(metadata));

            return new UploadedFileResponse(metadata.id(), metadata.originalName(),
                                            metadata.mimeType(), metadata.sizeBytes(),
                                            metadata.storedPath());

        } catch (FileUploadException fex) {
            /* bubble up untouched */
            throw fex;
        } catch (IOException ioex) {
            String msg = "Failed storing uploaded file";
            LOG.log(Level.WARNING, msg, ioex);
            throw new FileUploadException(
                    FileUploadException.ErrorCode.IO_FAILURE, msg, ioex);
        }
    }

    /* ---------------------------------------------------  PRIVATE METHODS */

    private void validate(String originalFilename, String mimeType, String userId)
            throws FileUploadException {

        if (originalFilename == null || originalFilename.isBlank()) {
            throw new FileUploadException(FileUploadException.ErrorCode.VALIDATION,
                    "Original filename is required.");
        }

        if (userId == null || userId.isBlank()) {
            throw new FileUploadException(FileUploadException.ErrorCode.VALIDATION,
                    "Uploader userId is required.");
        }

        if (!ALLOWED_MIME_TYPES.contains(mimeType)) {
            throw new FileUploadException(FileUploadException.ErrorCode.UNSUPPORTED_MEDIA_TYPE,
                    "Mime-type not permitted: " + mimeType);
        }
    }

    private static String resolveExtension(String filename) {
        int idx = filename.lastIndexOf('.');
        return (idx >= 0) ? filename.substring(idx) : "";
    }
}

/* ════════════════════════════════════════════════════════════════════════
 * Domain 𝙈𝙤𝙙𝙚𝙡 & Infrastructure — kept package-private for brevity
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Immutable metadata representing an uploaded artifact.
 * A proper JPA entity would annotate fields with @Id, @Column, etc.
 */
record FileMetadata(UUID id,
                    String originalName,
                    String mimeType,
                    String storedPath,
                    long   sizeBytes,
                    String uploaderUserId,
                    Instant createdAt) { }

/**
 * Contract for persisting {@link FileMetadata}. Swappable for JPA.
 */
interface FileRepository {
    void save(FileMetadata metadata) throws IOException;
    Optional<FileMetadata> findById(UUID id) throws IOException;
}

/**
 * Simple in-memory repository used as default for testing/demo purposes.
 */
class InMemoryFileRepository implements FileRepository {

    private final Map<UUID, FileMetadata> store = new ConcurrentHashMap<>();

    @Override
    public void save(FileMetadata metadata) {
        store.put(metadata.id(), metadata);
    }

    @Override
    public Optional<FileMetadata> findById(UUID id) {
        return Optional.ofNullable(store.get(id));
    }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Domain Events & Messaging
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Base type for all domain events in the platform.
 */
abstract class DomainEvent {
    private final UUID    id          = UUID.randomUUID();
    private final Instant occurredOn  = Instant.now();

    public UUID id()        { return id; }
    public Instant time()   { return occurredOn; }
}

/**
 * Event emitted after a successful file upload.
 */
class FileUploadedEvent extends DomainEvent {
    private final FileMetadata metadata;

    FileUploadedEvent(FileMetadata metadata) {
        this.metadata = metadata;
    }

    public FileMetadata metadata() { return metadata; }
}

/**
 * Publisher contract so different adapters (Kafka, Rabbit, SNS) can coexist.
 */
interface EventPublisher {
    void publish(DomainEvent event);
    <E extends DomainEvent> void registerListener(
            Class<E> clazz, DomainEventListener<E> listener);
}

/**
 * Functional interface representing a projection/handler for some domain event.
 */
@FunctionalInterface
interface DomainEventListener<E extends DomainEvent> {
    void onEvent(E event);
}

/**
 * Basic asynchronous, in-process event bus. Uses a single thread executor
 * because listeners are expected to be non-blocking. For I/O heavy listeners,
 * adapt to a larger pool or a true message broker.
 */
class AsyncEventPublisher implements EventPublisher, AutoCloseable {

    private final Map<Class<?>, Collection<DomainEventListener<?>>> listeners = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "domain-event-dispatcher");
        t.setDaemon(true);
        return t;
    });

    @Override
    public void publish(DomainEvent event) {
        Collection<DomainEventListener<?>> set = listeners.get(event.getClass());
        if (set == null || set.isEmpty()) { return; }

        for (DomainEventListener<?> raw : set) {
            @SuppressWarnings("unchecked")
            DomainEventListener<DomainEvent> safe = (DomainEventListener<DomainEvent>) raw;

            executor.submit(() -> {
                try { safe.onEvent(event); }
                catch (Exception ex) {
                    Logger.getLogger(getClass().getName())
                          .log(Level.SEVERE, "Listener failure", ex);
                }
            });
        }
    }

    @Override
    public <E extends DomainEvent> void registerListener(
            Class<E> clazz, DomainEventListener<E> listener) {

        listeners.computeIfAbsent(clazz, k -> ConcurrentHashMap.newKeySet())
                 .add(listener);
    }

    @Override
    public void close() { executor.shutdown(); }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Sample listener demonstrating email notification after file upload.
 * In real life, delegate to a mail service / SMTP adapter.
 * ───────────────────────────────────────────────────────────────────────── */

class EmailNotificationListener implements DomainEventListener<FileUploadedEvent> {

    private static final Logger LOG = Logger.getLogger(EmailNotificationListener.class.getName());

    @Override
    public void onEvent(FileUploadedEvent event) {
        FileMetadata md = event.metadata();
        // Simulated email dispatch.
        LOG.info(() -> String.format(
                "📧  Queued email: '%s' successfully uploaded (%s bytes) at %s",
                md.originalName(), md.sizeBytes(), md.createdAt()));
    }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Checked Exception hierarchy for upload failures
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Fine-grained, meaningful exception used by {@link FileUploadService}.
 */
class FileUploadException extends Exception {
    enum ErrorCode {
        VALIDATION,
        UNSUPPORTED_MEDIA_TYPE,
        IO_FAILURE
    }

    private final ErrorCode code;

    FileUploadException(ErrorCode code, String message) {
        super(message);
        this.code = code;
    }

    FileUploadException(ErrorCode code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public ErrorCode code() { return code; }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Utility stream that aborts copy once MAX_FILE_SIZE_BYTES is exceeded.
 * ───────────────────────────────────────────────────────────────────────── */

class BoundedInputStream extends InputStream {

    private final InputStream delegate;
    private final long maxBytes;
    private long bytesRead = 0;

    BoundedInputStream(InputStream delegate, long maxBytes) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        this.maxBytes = maxBytes;
    }

    @Override
    public int read() throws IOException {
        int b = delegate.read();
        if (b != -1) { onByteRead(1); }
        return b;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        int count = delegate.read(b, off, len);
        if (count > 0) { onByteRead(count); }
        return count;
    }

    private void onByteRead(int n) throws FileUploadException {
        bytesRead += n;
        if (bytesRead > maxBytes) {
            throw new FileUploadException(
                    FileUploadException.ErrorCode.VALIDATION,
                    "File exceeds maximum allowed size (" + maxBytes + " bytes).");
        }
    }
}

/* ════════════════════════════════════════════════════════════════════════
 * Quick self-contained demo (not part of production deployment)
 * ════════════════════════════════════════════════════════════════════════ */

class Demo {
    public static void main(String[] args) throws Exception {

        Path storageRoot = Paths.get("uploads");
        InMemoryFileRepository repo = new InMemoryFileRepository();
        AsyncEventPublisher publisher = new AsyncEventPublisher();

        publisher.registerListener(FileUploadedEvent.class, new EmailNotificationListener());

        FileUploadService service = new FileUploadService(storageRoot, repo, publisher);

        try (InputStream sample = Files.newInputStream(
                Paths.get("src/test/resources/sample.pdf"))) {

            UploadedFileResponse resp = service.handleUpload(
                    sample,
                    "assignment-draft.pdf",
                    "application/pdf",
                    "user-123"
            );

            System.out.printf("Upload successful: %s%n", resp);
        }
    }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Value object returned to API callers following successful upload.
 * ───────────────────────────────────────────────────────────────────────── */

record UploadedFileResponse(UUID   id,
                            String originalName,
                            String mimeType,
                            long   sizeBytes,
                            String storedPath) {
    @Override
    public String toString() {
        return String.format("[id=%s, name=%s, mime=%s, size=%dB, path=%s]",
                id, originalName, mimeType, sizeBytes, storedPath);
    }
}
```