package com.circleconnect.nexus.metrics;

import com.circleconnect.nexus.domain.Circle;
import com.circleconnect.nexus.domain.Post;
import com.circleconnect.nexus.repository.CircleRepository;
import com.circleconnect.nexus.repository.InfluenceScoreRepository;
import com.circleconnect.nexus.repository.PostRepository;
import com.circleconnect.nexus.shared.lock.DistributedLockService;
import com.circleconnect.nexus.shared.lock.LockGuard;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.List;
import java.util.OptionalDouble;
import java.util.concurrent.TimeUnit;

/**
 * Recalculates and caches the “influence score” of every active {@link Circle}.
 *
 * – Runs every 15 minutes (see @Scheduled expression below)
 * – Reads only “dirty” circle data in small batches to prevent memory spikes
 * – Writes updated scores in a single transaction for each batch
 * – Publishes Prometheus/Micrometer metrics for observability
 *
 * This class purposely lives in its own source file because it is both
 * stateful (runtime cache) and central to CircleConnect’s content-ranking
 * pipeline, which makes it a clear module boundary.
 *
 * NOTE: Computational details (weights, fields, etc.) are deliberately
 * configurable via application-properties to keep this class open for
 * product-side experimentation without redeployment.
 */
@Service
public class Module9 {

    private static final Logger LOGGER = LoggerFactory.getLogger(Module9.class);
    private static final String LOCK_NAME = "influence-score-global-recalc";

    private final CircleRepository circleRepository;
    private final PostRepository postRepository;
    private final InfluenceScoreRepository scoreRepository;
    private final DistributedLockService distributedLockService;
    private final Cache<Long, Double> scoreCache;
    private final Counter recalculationCounter;
    private final Timer recalculationTimer;

    @Value("${nexus.influence.weight.posts:1.0}")
    private double weightPosts;

    @Value("${nexus.influence.weight.reactions:0.75}")
    private double weightReactions;

    @Value("${nexus.influence.weight.members:0.50}")
    private double weightMembers;

    @Value("${nexus.influence.recalc.batch-size:250}")
    private int batchSize;

    public Module9(CircleRepository circleRepository,
                   PostRepository postRepository,
                   InfluenceScoreRepository scoreRepository,
                   DistributedLockService distributedLockService,
                   MeterRegistry meterRegistry) {

        this.circleRepository = circleRepository;
        this.postRepository = postRepository;
        this.scoreRepository = scoreRepository;
        this.distributedLockService = distributedLockService;

        // Local in-memory cache to speed up read paths.
        this.scoreCache = Caffeine.newBuilder()
                                  .maximumSize(10_000)
                                  .expireAfterWrite(10, TimeUnit.MINUTES)
                                  .build();

        // Metrics
        this.recalculationCounter = meterRegistry.counter("nexus.influence.recalculation.count");
        this.recalculationTimer = meterRegistry.timer("nexus.influence.recalculation.timer");
    }

    /**
     * Scheduled entry-point – orchestrates the score recalculation pipeline.
     */
    @Scheduled(cron = "0 */15 * * * *") // every 15 minutes
    @Transactional
    public void recalculateInfluenceScores() {
        // Attempt to acquire a cross-instance lock so we do not double-recalculate in clustered run-time.
        try (LockGuard ignored = distributedLockService.tryLock(LOCK_NAME, Duration.ofMinutes(10))) {
            if (ignored == null) {
                LOGGER.debug("Another node is already recalculating influence scores – aborting.");
                return;
            }

            long startNanos = System.nanoTime();
            int totalUpdated = 0;

            for (int page = 0; ; page++) {
                List<Circle> circles = circleRepository.findAllActive(PageRequest.of(page, batchSize));
                if (circles.isEmpty()) {
                    break;
                }

                for (Circle circle : circles) {
                    double newScore = calculateScore(circle);

                    // Short-circuit if nothing changed.
                    if (!scoreRepository.isScoreChanged(circle.getId(), newScore)) {
                        continue;
                    }

                    // Persist new score & refresh cache
                    scoreRepository.saveOrUpdate(circle.getId(), newScore);
                    scoreCache.put(circle.getId(), newScore);
                    totalUpdated++;
                }
            }

            long elapsedNanos = System.nanoTime() - startNanos;
            recalculationCounter.increment(totalUpdated);
            recalculationTimer.record(elapsedNanos, TimeUnit.NANOSECONDS);

            LOGGER.info("Influence-score recalculation finished – updated {} circles in {} ms.",
                        totalUpdated, TimeUnit.NANOSECONDS.toMillis(elapsedNanos));
        } catch (DataAccessException dae) {
            LOGGER.error("Database error during influence-score recalculation.", dae);
            throw dae; // surfaces to the scheduler for retry/back-off strategy
        } catch (Exception ex) {
            LOGGER.error("Unexpected error during influence-score recalculation.", ex);
        }
    }

    /**
     * Returns the most recent influence score for the given circle, preferring
     * the in-memory cache where available.
     */
    public OptionalDouble getCachedScore(long circleId) {
        Double cached = scoreCache.getIfPresent(circleId);
        if (cached != null) {
            return OptionalDouble.of(cached);
        }
        return scoreRepository.findScore(circleId);
    }

    /**
     * Computes a weight-based influence score for the provided {@link Circle}.
     *
     * The formula is:
     *   score = (posts * w₁) + (reactions * w₂) + (members * w₃)
     *
     * – posts      : total number of posts in last 30 days
     * – reactions  : sum of all reactions (likes, votes, pledges) in last 30 days
     * – members    : current active member count
     */
    private double calculateScore(Circle circle) {
        // Domain queries are intentionally narrow to keep the cost bounded.
        long postCount = postRepository.countRecentPosts(circle.getId(), Duration.ofDays(30));
        long reactionCount = postRepository.sumRecentReactions(circle.getId(), Duration.ofDays(30));
        long memberCount = circleRepository.countActiveMembers(circle.getId());

        // Weighted sum – all weights configurable.
        return postCount   * weightPosts +
               reactionCount * weightReactions +
               memberCount   * weightMembers;
    }
}