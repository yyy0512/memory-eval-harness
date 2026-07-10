```java
package com.circleconnect.nexus.influence;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.annotation.Nonnull;
import javax.annotation.PostConstruct;
import javax.annotation.PreDestroy;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * CircleInfluenceScoreService evaluates the individual member influence inside a Circle.
 * <p>
 * The score is used to fine-tune feed ordering, visibility and reward mechanisms. It is
 * persisted asynchronously, cached aggressively, and recalculated on a rolling schedule.
 *
 * Real-world considerations addressed:
 *  • Thread-safety & concurrency                                 – handled via ExecutorService
 *  • Performance & hot-path optimisation                         – Caffeine cache
 *  • Resilience & graceful degradation                           – extensive error handling
 *  • Testability                                                 – explicit dependencies and pure functions
 *  • Observability                                               – SLF4J structured logging
 */
@Service
public class CircleInfluenceScoreService implements InitializingBean, DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(CircleInfluenceScoreService.class);

    /**
     * Weighting strategy used to calculate influence scores.
     * Pluggable for easy A/B experimentation.
     */
    public interface InfluenceScoreStrategy {
        double weight(@Nonnull InfluenceAction action);
    }

    /**
     * A simple default weighting implementation that can be overridden by Spring context.
     */
    public static class DefaultInfluenceScoreStrategy implements InfluenceScoreStrategy {
        private final Map<InfluenceAction, Double> weights = Map.of(
                InfluenceAction.POST_CREATED, 2.5,
                InfluenceAction.COMMENT_CREATED, 1.0,
                InfluenceAction.VOTE_CAST, 0.5,
                InfluenceAction.EVENT_ATTENDED, 3.0,
                InfluenceAction.PLEDGE_MADE, 4.0
        );

        @Override
        public double weight(@Nonnull InfluenceAction action) {
            return weights.getOrDefault(action, 0.0);
        }
    }

    /**
     * Enumeration of recognised influence-bearing actions.
     */
    public enum InfluenceAction {
        POST_CREATED,
        COMMENT_CREATED,
        VOTE_CAST,
        EVENT_ATTENDED,
        PLEDGE_MADE
    }

    /**
     * Domain projection representing an activity produced by a Circle member.
     * This abstraction shields the service from underlying entity structures.
     */
    public static final class ActivityLog {
        private final UUID circleId;
        private final UUID memberId;
        private final InfluenceAction action;
        private final Instant timestamp;

        public ActivityLog(UUID circleId, UUID memberId,
                           InfluenceAction action, Instant timestamp) {
            this.circleId = Objects.requireNonNull(circleId);
            this.memberId = Objects.requireNonNull(memberId);
            this.action = Objects.requireNonNull(action);
            this.timestamp = Objects.requireNonNull(timestamp);
        }

        public UUID getCircleId() {
            return circleId;
        }

        public UUID getMemberId() {
            return memberId;
        }

        public InfluenceAction getAction() {
            return action;
        }

        public Instant getTimestamp() {
            return timestamp;
        }
    }

    /* ------------------------------------------------------------------
     * Repositories – defined as interfaces to promote mocking in tests.
     * ------------------------------------------------------------------ */

    public interface ActivityLogRepository {
        /**
         * Fetches activities for a given Circle that occurred after {@code sinceTimestamp}.
         */
        List<ActivityLog> findByCircleIdAndSince(UUID circleId, Instant sinceTimestamp);
    }

    public interface CircleInfluenceScoreRepository {
        /**
         * Persist final score for a member.
         */
        void upsertInfluenceScore(UUID circleId, UUID memberId, double score);

        /**
         * Bulk persistence optimisation.
         */
        void upsertInfluenceScoreBatch(UUID circleId, Map<UUID, Double> scores);
    }

    /* ------------------------------------------------------------------ */
    /* Dependencies injected by Spring                                    */
    /* ------------------------------------------------------------------ */
    private final ActivityLogRepository activityLogRepository;
    private final CircleInfluenceScoreRepository influenceScoreRepository;
    private final InfluenceScoreStrategy scoreStrategy;

    /* ------------------------------------------------------------------ */
    /* Runtime configuration                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Max age (days) of activity logs considered in score computation.
     */
    private final int lookbackDays;

    /**
     * Maximum number of outstanding async computations allowed. Configurable to protect DB.
     */
    private final int parallelism;

    /* ------------------------------------------------------------------ */
    /* Internal state                                                     */
    /* ------------------------------------------------------------------ */
    private final ExecutorService executorService;
    private final Cache<CacheKey, Double> influenceCache;

    public CircleInfluenceScoreService(
            ActivityLogRepository activityLogRepository,
            CircleInfluenceScoreRepository influenceScoreRepository,
            Optional<InfluenceScoreStrategy> scoreStrategyOptional,
            @Value("${circle.influence.lookback-days:30}") int lookbackDays,
            @Value("${circle.influence.parallelism:4}") int parallelism) {

        this.activityLogRepository = Objects.requireNonNull(activityLogRepository);
        this.influenceScoreRepository = Objects.requireNonNull(influenceScoreRepository);
        this.scoreStrategy = scoreStrategyOptional.orElseGet(DefaultInfluenceScoreStrategy::new);
        this.lookbackDays = lookbackDays;
        this.parallelism = parallelism;

        this.executorService = Executors.newFixedThreadPool(parallelism, r -> {
            Thread t = new Thread(r, "circle-influence-worker");
            t.setDaemon(true);
            return t;
        });

        this.influenceCache = Caffeine.newBuilder()
                .expireAfterWrite(30, TimeUnit.MINUTES)
                .maximumSize(50_000)
                .build();
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle hooks                                                    */
    /* ------------------------------------------------------------------ */

    @PostConstruct
    @Override
    public void afterPropertiesSet() {
        log.info("CircleInfluenceScoreService initialised with lookback={} days, parallelism={}",
                 lookbackDays, parallelism);
    }

    @PreDestroy
    @Override
    public void destroy() {
        executorService.shutdown();
        try {
            if (!executorService.awaitTermination(5, TimeUnit.SECONDS)) {
                executorService.shutdownNow();
            }
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            executorService.shutdownNow();
        }
        log.info("CircleInfluenceScoreService shut down gracefully");
    }

    /* ------------------------------------------------------------------ */
    /* Public API                                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Returns current influence score for given member & circle.
     * If the score isn't cached, triggers a sync recalculation for the specific circle
     * to avoid stale reads.
     */
    @Transactional(readOnly = true)
    public double getInfluenceScore(UUID circleId, UUID memberId) {
        CacheKey key = new CacheKey(circleId, memberId);
        Double score = influenceCache.getIfPresent(key);

        if (score != null) {
            return score;
        }

        // Fallback to synchronous computation (rare path).
        Map<UUID, Double> scores = computeScoresForCircle(circleId);
        influenceCacheScores(circleId, scores);

        return scores.getOrDefault(memberId, 0.0);
    }

    /**
     * Triggers an immediate asynchronous recalculation for specified circle.
     * Applicable after bulk-write operations such as admin migrations.
     */
    public void recalculateAsync(UUID circleId) {
        executorService.submit(() -> {
            try {
                Map<UUID, Double> scores = computeScoresForCircle(circleId);
                influenceScoreRepository.upsertInfluenceScoreBatch(circleId, scores);
                influenceCacheScores(circleId, scores);
                log.debug("Asynchronous influence score recalculation completed for circle={}", circleId);
            } catch (Exception ex) {
                log.error("Unable to recalculate influence scores asynchronously for circle={}", circleId, ex);
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Scheduled jobs                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Periodically refreshes influence scores for all active Circles.
     * Cron triggers at minute 17 every hour to avoid thundering-herd with other jobs.
     */
    @Scheduled(cron = "0 17 * * * *")
    public void scheduledRecalculation() {
        log.info("Launching scheduled influence score job");

        // In production we would stream circle IDs from repository to avoid loading all into memory.
        List<UUID> activeCircleIds = fetchActiveCircleIds();
        for (UUID circleId : activeCircleIds) {
            executorService.submit(() -> {
                try {
                    Map<UUID, Double> scores = computeScoresForCircle(circleId);
                    influenceScoreRepository.upsertInfluenceScoreBatch(circleId, scores);
                    influenceCacheScores(circleId, scores);
                } catch (Exception ex) {
                    log.error("Failed influence score recomputation for circle={}", circleId, ex);
                }
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* Core algorithm                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Computes influence scores for every member in a given circle.
     * Complexity is O(n) where n is # of log entries in the time window.
     */
    @Transactional(readOnly = true)
    protected Map<UUID, Double> computeScoresForCircle(UUID circleId) {
        Instant since = Instant.now().minus(Duration.ofDays(lookbackDays));
        List<ActivityLog> logs = activityLogRepository.findByCircleIdAndSince(circleId, since);

        Map<UUID, Double> scores = new HashMap<>();
        logs.forEach(logEntry -> {
            UUID memberId = logEntry.getMemberId();
            double weight = scoreStrategy.weight(logEntry.getAction());
            scores.merge(memberId, weight, Double::sum);
        });

        // Normalisation step – convert raw weights into 0..100 range for UX consumption.
        double max = scores.values().stream().mapToDouble(Double::doubleValue).max().orElse(1.0);
        scores.replaceAll((member, raw) -> (raw / max) * 100.0);

        return scores;
    }

    /* ------------------------------------------------------------------ */
    /* Helper methods                                                     */
    /* ------------------------------------------------------------------ */

    private void influenceCacheScores(UUID circleId, Map<UUID, Double> scores) {
        scores.forEach((memberId, score) ->
                influenceCache.put(new CacheKey(circleId, memberId), score));
    }

    /**
     * Placeholder to obtain circle IDs. In practice we'd inject a {@code CircleRepository}
     * and paginate through it to avoid loading millions of IDs simultaneously.
     */
    private List<UUID> fetchActiveCircleIds() {
        // TODO: Replace with repository fetch
        return Collections.emptyList();
    }

    /* ------------------------------------------------------------------ */
    /* Value Object used as a composite key in Caffeine cache.            */
    /* ------------------------------------------------------------------ */
    private record CacheKey(UUID circleId, UUID memberId) {
    }
}
```