```java
package com.circleconnect.nexus.domain.circle;

import com.circleconnect.nexus.domain.circle.event.CircleEvent;
import com.circleconnect.nexus.domain.circle.event.PledgeCreatedEvent;
import com.circleconnect.nexus.domain.circle.event.PostCreatedEvent;
import com.circleconnect.nexus.domain.circle.model.Circle;
import com.circleconnect.nexus.domain.circle.model.CircleEngagementAggregate;
import com.circleconnect.nexus.domain.circle.repository.CircleEngagementRepository;
import com.circleconnect.nexus.domain.circle.repository.CircleRepository;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.CachePut;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.Assert;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * CircleInfluenceService is responsible for the calculation and periodic refresh of
 * "influence scores" for Circles. An influence score determines how prominently a
 * Circle appears in feeds and discovery algorithms.
 *
 * The score is based on a weighted formula that considers:
 *   - recent post activity
 *   - comment volume
 *   - pledged amount
 *   - member participation in events
 *
 * Scores are cached for ultra-fast feed look-ups and are refreshed on a rolling
 * schedule and on-demand when engagement events come in.
 */
@Service
public class CircleInfluenceService {

    private static final Logger LOG = LoggerFactory.getLogger(CircleInfluenceService.class);

    /**
     * Weight constants tune the relative importance of each engagement facet.
     */
    private static final double WEIGHT_POSTS = 0.35;
    private static final double WEIGHT_COMMENTS = 0.20;
    private static final double WEIGHT_PLEDGE = 0.30;
    private static final double WEIGHT_EVENT_ATTENDANCE = 0.15;

    private final CircleEngagementRepository engagementRepository;
    private final CircleRepository circleRepository;
    private final Counter influenceRecalculationCounter;

    public CircleInfluenceService(CircleEngagementRepository engagementRepository,
                                  CircleRepository circleRepository,
                                  MeterRegistry meterRegistry) {
        this.engagementRepository = engagementRepository;
        this.circleRepository = circleRepository;
        this.influenceRecalculationCounter =
                meterRegistry.counter("circle.influence.recalculations");
    }

    // --------------------------------------------------------------------
    // Public API
    // --------------------------------------------------------------------

    /**
     * Force recalculation of a Circle's influence score and update the cache.
     *
     * @param circleId UUID of the target circle
     * @return recalculated score
     */
    @Transactional(readOnly = true)
    @CachePut(cacheNames = "circleInfluence", key = "#circleId")
    public double recalculateInfluence(UUID circleId) {
        Assert.notNull(circleId, "circleId must not be null");

        CircleEngagementAggregate aggregate = engagementRepository
                .findAggregateForCircle(circleId)
                .orElseThrow(() -> new IllegalStateException(
                        "No engagement aggregate found for circle " + circleId));

        double score = computeScore(aggregate);

        LOG.debug("Recalculated influence for circle {} -> {}", circleId, score);
        influenceRecalculationCounter.increment();
        return score;
    }

    /**
     * Retrieve the influence score from cache, falling back to calculation if not present.
     * This method is intentionally NOT transactional for maximum throughput.
     *
     * @param circleId UUID of the target circle
     * @return current influence score
     */
    @Cacheable(cacheNames = "circleInfluence", key = "#circleId")
    public double getInfluenceScore(UUID circleId) {
        LOG.trace("Cache miss for circle {}. Triggering calculation.", circleId);
        return recalculateInfluence(circleId);
    }

    // --------------------------------------------------------------------
    // Event Listeners
    // --------------------------------------------------------------------

    /**
     * Engagement events that should trigger a background refresh of the score.
     * We decouple the listener from the transaction via @Async so we don't delay
     * user-facing requests.
     */
    @Async
    @org.springframework.context.event.EventListener
    public CompletableFuture<Void> onCircleEngagementEvent(CircleEvent event) {
        if (event == null) {
            return CompletableFuture.completedFuture(null);
        }
        LOG.debug("Received engagement event {} for circle {}", event.getClass().getSimpleName(), event.getCircleId());
        return CompletableFuture.runAsync(() -> safeRecalculate(event.getCircleId()));
    }

    // --------------------------------------------------------------------
    // Scheduled Maintenance
    // --------------------------------------------------------------------

    /**
     * A rolling cron job that recomputes influence scores for the most active circles
     * over the last 24h. This ensures stale entries get refreshed even if cache TTL
     * is high.
     */
    @Scheduled(cron = "0 15 * * * *") // every hour at hh:15
    public void scheduledRefreshTopActiveCircles() {
        try {
            Instant since = Instant.now().minus(Duration.ofHours(24));
            List<UUID> activeCircleIds = engagementRepository.findTopActiveCirclesSince(since);
            LOG.info("Scheduled refresh: {} circles flagged as active since {}", activeCircleIds.size(), since);

            activeCircleIds.forEach(this::safeRecalculate);
        } catch (DataAccessException ex) {
            LOG.error("Failed to fetch top active circles for scheduled refresh", ex);
        }
    }

    /**
     * Nightly full flush. Removes every cache entry so subsequent requests recalculate
     * from scratch. This keeps the cache from drifting indefinitely.
     */
    @Scheduled(cron = "0 0 3 * * *") // every day at 03:00
    @CacheEvict(cacheNames = "circleInfluence", allEntries = true)
    public void nightlyCacheFlush() {
        LOG.info("Nightly influence-score cache flush executed.");
    }

    // --------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------

    private void safeRecalculate(UUID circleId) {
        try {
            recalculateInfluence(circleId);
        } catch (Exception ex) {
            // We swallow the exception intentionally so that caller threads are
            // not contaminated by recalculation failures.
            LOG.warn("Silent failure during influence recalculation for circle {}", circleId, ex);
        }
    }

    /**
     * Core scoring algorithm. Adjust the weights here to re-balance influence.
     */
    private double computeScore(CircleEngagementAggregate aggregate) {
        double score =
                WEIGHT_POSTS * normalize(aggregate.getPostCount()) +
                WEIGHT_COMMENTS * normalize(aggregate.getCommentCount()) +
                WEIGHT_PLEDGE * normalize(aggregate.getPledgedCents()) +
                WEIGHT_EVENT_ATTENDANCE * normalize(aggregate.getEventAttendance());

        return round(score, 4);
    }

    /**
     * Naïve logarithmic normalization to keep numbers in a comparable range.
     *
     * @param value raw integer value
     * @return normalized double between 0 and 1
     */
    private double normalize(long value) {
        if (value <= 0) return 0.0d;
        // using log10 keeps values within [0,∞). We cap at 1 using min().
        return Math.min(1.0d, Math.log10(value + 1) / 5.0d);
    }

    private static double round(double value, int precision) {
        double factor = Math.pow(10, precision);
        return Math.round(value * factor) / factor;
    }
}

/* ---------------------------------------------------------------------------------
 * Below are lightweight interface and model definitions to make this source file
 * self-contained. In the real codebase these would live in their own files.
 * --------------------------------------------------------------------------------- */

/**
 * Simplified read-only projection of aggregated engagement stats for a circle.
 */
class CircleEngagementAggregate {

    private final long postCount;
    private final long commentCount;
    private final long pledgedCents;
    private final long eventAttendance;

    public CircleEngagementAggregate(long postCount,
                                     long commentCount,
                                     long pledgedCents,
                                     long eventAttendance) {
        this.postCount = postCount;
        this.commentCount = commentCount;
        this.pledgedCents = pledgedCents;
        this.eventAttendance = eventAttendance;
    }

    public long getPostCount() {
        return postCount;
    }

    public long getCommentCount() {
        return commentCount;
    }

    public long getPledgedCents() {
        return pledgedCents;
    }

    public long getEventAttendance() {
        return eventAttendance;
    }
}

interface CircleEngagementRepository {

    /**
     * Returns the engagement aggregate for a circle or empty if the circle has no activity.
     */
    java.util.Optional<CircleEngagementAggregate> findAggregateForCircle(UUID circleId);

    /**
     * Returns the circle IDs that show the highest engagement within the given timeframe.
     */
    List<UUID> findTopActiveCirclesSince(Instant since);
}

interface CircleRepository {
    java.util.Optional<Circle> findById(UUID circleId);
}

/**
 * Placeholder domain object.
 */
class Circle {
    private UUID id;
    private String name;
    // Additional fields omitted.
}

/* ---------------------------------------------------------------------------------
 * Engagement event hierarchy
 * --------------------------------------------------------------------------------- */

abstract class CircleEvent {
    private final UUID circleId;

    protected CircleEvent(UUID circleId) {
        this.circleId = circleId;
    }

    public UUID getCircleId() {
        return circleId;
    }
}

class PostCreatedEvent extends CircleEvent {
    public PostCreatedEvent(UUID circleId) {
        super(circleId);
    }
}

class PledgeCreatedEvent extends CircleEvent {
    public PledgeCreatedEvent(UUID circleId) {
        super(circleId);
    }
}
```