```java
/*
 * EduPulse Live Learning Hub
 * ----------------------------------------------------------------------
 * Centralized, type–safe configuration holder with environment/property
 * resolution, validation, and minimal dynamic‐reload capabilities.
 *
 * This class is intentionally placed in the root (default) package so it
 * can be referenced from anywhere in the code-base without incurring
 * package-import churn.  In a real-world code-base you would most likely
 * move this to a dedicated config package (e.g. com.edupulse.config).
 *
 * File path (relative to project root): src/config.java
 *
 * NOTE: Because the filename is lower-case (“config.java”), the class is
 * NOT declared public—allowing the JVM to compile it even though the file
 * name does not match the type name’s case exactly.  The class is marked
 * final because configuration should be immutable after construction.
 */

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.*;
import java.time.Duration;
import java.util.Collections;
import java.util.Objects;
import java.util.Optional;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Centralised configuration for EduPulse.
 *
 * Supports:
 *   • Loading from a properties file (location can be overridden via
 *     environment variable “EDUPULSE_CONFIG_PATH”).
 *   • Overriding individual keys with environment variables prefixed with
 *     “EDUPULSE_” (e.g. EDUPULSE_DB_URL overrides db.url).
 *   • Validation of all required keys.
 *   • Lightweight, best‐effort hot-reloading on file modification.
 *
 * Thread-safety: the class is fully immutable after creation; the static
 * reference returned by {@link #get()} is replaced on hot reload and is
 * therefore safe to publish.  Consumers should always obtain the latest
 * instance via get().
 */
final class Config {

    // ---------------------------------------------------------------------
    // Public access
    // ---------------------------------------------------------------------

    /**
     * Global accessor.  Behind the scenes this may be swapped out by the
     * file-watcher when the underlying configuration file changes.
     */
    public static Config get() {
        return INSTANCE_REF.get();
    }

    // ---------------------------------------------------------------------
    // Immutable fields
    // ---------------------------------------------------------------------

    private final Environment env;

    // Database
    private final String dbUrl;
    private final String dbUser;
    private final String dbPassword;

    // Broker
    private final String brokerHost;
    private final int    brokerPort;
    private final String brokerPulseTopic;
    private final String brokerNotificationTopic;
    private final String brokerPaymentTopic;

    // Mail
    private final String smtpHost;
    private final int    smtpPort;
    private final String smtpUser;
    private final String smtpPassword;

    // File uploads
    private final Path   uploadRoot;
    private final long   maxUploadBytes;

    // Logging
    private final Level  logLevel;
    private final Path   logFile;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    private Config(Properties p) throws ConfigException {

        // ENVIRONMENT -----------------------------------------------------
        this.env = Environment.valueOf(
                require(p, "env")
                        .toUpperCase());

        // DATABASE --------------------------------------------------------
        this.dbUrl      = require(p, "db.url");
        this.dbUser     = require(p, "db.user");
        this.dbPassword = require(p, "db.password");

        // BROKER ----------------------------------------------------------
        this.brokerHost              = require(p, "broker.host");
        this.brokerPort              = parseInt(p, "broker.port");
        this.brokerPulseTopic        = require(p, "broker.topic.pulse");
        this.brokerNotificationTopic = require(p, "broker.topic.notification");
        this.brokerPaymentTopic      = require(p, "broker.topic.payment");

        // MAIL ------------------------------------------------------------
        this.smtpHost     = require(p, "mail.smtp.host");
        this.smtpPort     = parseInt(p, "mail.smtp.port");
        this.smtpUser     = require(p, "mail.smtp.user");
        this.smtpPassword = require(p, "mail.smtp.password");

        // FILE UPLOAD -----------------------------------------------------
        this.uploadRoot      = Paths.get(require(p, "upload.root")).toAbsolutePath();
        this.maxUploadBytes  = parseLong(p, "upload.maxBytes");

        // LOGGING ---------------------------------------------------------
        this.logLevel = Level.parse(require(p, "log.level").toUpperCase());
        this.logFile  = Paths.get(require(p, "log.file")).toAbsolutePath();

        // Extra sanity checks
        validate();
    }

    // ---------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------

    private void validate() {
        if (brokerPort <= 0 || brokerPort > 65535)
            throw new ConfigException("broker.port out of range");

        if (smtpPort <= 0 || smtpPort > 65535)
            throw new ConfigException("mail.smtp.port out of range");

        if (maxUploadBytes <= 0)
            throw new ConfigException("upload.maxBytes must be positive");
    }

    // ---------------------------------------------------------------------
    // Static bootstrap + hot-reload
    // ---------------------------------------------------------------------

    private static final Logger LOGGER =
            Logger.getLogger(Config.class.getName());

    // Atomic reference used to swap config on reload
    private static final class Holder {
        private volatile Config cfg;
        private Config get() { return cfg; }
        private void   set(Config c) { cfg = c; }
    }

    private static final Holder INSTANCE_REF = new Holder();

    static {
        try {
            // Initial load
            INSTANCE_REF.set(loadFromDisk());

            // Kick off watcher thread (non-blocking)
            ConfigReloader.bootstrap();
        } catch (ConfigException e) {
            LOGGER.log(Level.SEVERE, "Failed to bootstrap configuration", e);
            // Re-throw to fail fast—whole application should not start
            throw e;
        }
    }

    /**
     * Load configuration from disk + environment variable overrides.
     */
    private static Config loadFromDisk() throws ConfigException {
        final String explicitPath =
                System.getenv("EDUPULSE_CONFIG_PATH");

        final Path path =
                explicitPath != null
                  ? Paths.get(explicitPath)
                  : Paths.get("config", "edupulse.properties");

        final Properties props = new Properties();

        // 1) Load from file
        try (InputStream in = new FileInputStream(path.toFile())) {
            props.load(in);
            LOGGER.info(() -> "Loaded configuration file: " + path.toAbsolutePath());
        } catch (IOException e) {
            throw new ConfigException("Unable to read config file: " + path, e);
        }

        // 2) Override with environment variables
        overrideWithEnv(props);

        // 3) Resolve ${VAR} placeholders (basic implementation)
        resolvePlaceholders(props);

        return new Config(props);
    }

    // ---------------------------------------------------------------------
    // Environment overrides & placeholder resolution
    // ---------------------------------------------------------------------

    private static void overrideWithEnv(Properties props) {
        final String prefix = "EDUPULSE_";
        final Set<String> envKeys =
                System.getenv().keySet();

        envKeys.stream()
               .filter(k -> k.startsWith(prefix))
               .forEach(k -> {
                   final String propertyKey =
                           k.substring(prefix.length())
                            .toLowerCase()
                            .replace('_', '.'); // EDUPULSE_DB_URL -> db.url
                   final String value = System.getenv(k);
                   props.setProperty(propertyKey, value);
               });
    }

    private static void resolvePlaceholders(Properties props) {
        // Very small-scope placeholder resolution: ${key}
        for (String name : props.stringPropertyNames()) {
            String val = props.getProperty(name);
            if (val.contains("${")) {
                int start = val.indexOf("${");
                int end   = val.indexOf('}', start);
                if (end > start) {
                    String ref = val.substring(start + 2, end);
                    String replacement = props.getProperty(ref, "");
                    val = val.substring(0, start) + replacement + val.substring(end + 1);
                    props.setProperty(name, val);
                }
            }
        }
    }

    // ---------------------------------------------------------------------
    // Helper utilities
    // ---------------------------------------------------------------------

    private static String require(Properties p, String k) {
        String val = p.getProperty(k);
        if (val == null || val.trim().isEmpty())
            throw new ConfigException("Missing property: " + k);
        return val.trim();
    }

    private static int parseInt(Properties p, String k) {
        try {
            return Integer.parseInt(require(p, k));
        } catch (NumberFormatException ex) {
            throw new ConfigException("Property not an int: " + k, ex);
        }
    }

    private static long parseLong(Properties p, String k) {
        try {
            return Long.parseLong(require(p, k));
        } catch (NumberFormatException ex) {
            throw new ConfigException("Property not a long: " + k, ex);
        }
    }

    // ---------------------------------------------------------------------
    // Lightweight hot-reload using WatchService
    // ---------------------------------------------------------------------

    private static final class ConfigReloader implements Runnable {

        private final Path configFile;
        private final Path dir;

        private ConfigReloader(Path configFile) {
            this.configFile = configFile;
            this.dir        = configFile.getParent();
        }

        static void bootstrap() {
            final String pathStr =
                    Optional.ofNullable(System.getenv("EDUPULSE_CONFIG_PATH"))
                            .orElse(Paths.get("config", "edupulse.properties").toString());

            final Path path = Paths.get(pathStr);

            // Do not start watcher if file is on classpath/jar
            if (!Files.isRegularFile(path)) {
                LOGGER.warning("Config path points to non-regular file; hot reload disabled.");
                return;
            }

            final Thread watcher = new Thread(new ConfigReloader(path), "config-watcher");
            watcher.setDaemon(true);
            watcher.start();
        }

        @Override
        public void run() {
            try (WatchService ws = FileSystems.getDefault().newWatchService()) {

                dir.register(ws,
                        StandardWatchEventKinds.ENTRY_MODIFY,
                        StandardWatchEventKinds.ENTRY_CREATE);

                LOGGER.info(() -> "Config watcher started: " + configFile);

                while (true) {
                    WatchKey key = ws.take(); // blocking
                    for (WatchEvent<?> event : key.pollEvents()) {

                        if (event.context() instanceof Path) {
                            Path changed = dir.resolve((Path) event.context());
                            if (Files.isSameFile(changed, configFile)) {
                                reloadWithDebounce();
                            }
                        }
                    }
                    key.reset();
                }

            } catch (IOException | InterruptedException e) {
                LOGGER.log(Level.WARNING, "Config watcher stopped", e);
                Thread.currentThread().interrupt();
            }
        }

        private void reloadWithDebounce() {
            // Simple debounce: wait a bit for file writes to complete
            try {
                Thread.sleep(Duration.ofSeconds(1).toMillis());
                Config newCfg = loadFromDisk();
                INSTANCE_REF.set(newCfg);
                LOGGER.info("Configuration reloaded");
            } catch (Exception e) {
                LOGGER.log(Level.SEVERE, "Failed to reload configuration", e);
            }
        }
    }

    // ---------------------------------------------------------------------
    // Accessors
    // ---------------------------------------------------------------------

    public Environment getEnvironment()          { return env; }
    public String      getDbUrl()                { return dbUrl; }
    public String      getDbUser()               { return dbUser; }
    public String      getDbPassword()           { return dbPassword; }
    public String      getBrokerHost()           { return brokerHost; }
    public int         getBrokerPort()           { return brokerPort; }
    public String      getBrokerPulseTopic()     { return brokerPulseTopic; }
    public String      getBrokerNotificationTopic() { return brokerNotificationTopic; }
    public String      getBrokerPaymentTopic()   { return brokerPaymentTopic; }
    public String      getSmtpHost()             { return smtpHost; }
    public int         getSmtpPort()             { return smtpPort; }
    public String      getSmtpUser()             { return smtpUser; }
    public String      getSmtpPassword()         { return smtpPassword; }
    public Path        getUploadRoot()           { return uploadRoot; }
    public long        getMaxUploadBytes()       { return maxUploadBytes; }
    public Level       getLogLevel()             { return logLevel; }
    public Path        getLogFile()             { return logFile; }

    /**
     * Converts this config into an immutable <code>java.util.Properties</code>
     * instance.  Useful for libraries that operate on Properties objects.
     */
    public Properties asProperties() {
        Properties p = new Properties();
        p.put("env", env.name());
        p.put("db.url", dbUrl);
        p.put("db.user", dbUser);
        p.put("db.password", dbPassword);
        p.put("broker.host", brokerHost);
        p.put("broker.port", String.valueOf(brokerPort));
        p.put("broker.topic.pulse", brokerPulseTopic);
        p.put("broker.topic.notification", brokerNotificationTopic);
        p.put("broker.topic.payment", brokerPaymentTopic);
        p.put("mail.smtp.host", smtpHost);
        p.put("mail.smtp.port", String.valueOf(smtpPort));
        p.put("mail.smtp.user", smtpUser);
        p.put("mail.smtp.password", smtpPassword);
        p.put("upload.root", uploadRoot.toString());
        p.put("upload.maxBytes", String.valueOf(maxUploadBytes));
        p.put("log.level", logLevel.getName());
        p.put("log.file", logFile.toString());
        return p;
    }

    // ---------------------------------------------------------------------
    // Environment enum
    // ---------------------------------------------------------------------

    public enum Environment {
        DEV, STAGING, PROD
    }

    // ---------------------------------------------------------------------
    // Custom exception
    // ---------------------------------------------------------------------

    public static class ConfigException extends RuntimeException {
        public ConfigException(String message) { super(message); }
        public ConfigException(String message, Throwable cause) { super(message, cause); }
    }
}
```