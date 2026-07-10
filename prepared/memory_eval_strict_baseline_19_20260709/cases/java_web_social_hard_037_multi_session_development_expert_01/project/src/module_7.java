package com.circleconnect.nexus.analytics;

import com.circleconnect.nexus.domain.Circle;
import com.circleconnect.nexus.domain.User;
import com.circleconnect.nexus.domain.enums.ActivityType;
import com.circleconnect.nexus.exceptions.ResourceNotFoundException;
import com.circleconnect.nexus.repository.ActivityRepository;
import com.circleconnect.nexus.repository.CircleRepository;
import com.circleconnect.nexus.repository.UserRepository;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * InfluenceScoreService
 *
 * Computes, caches, and publishes the influence score of a user inside a given circle.
 * The score is used by the feed-ranking engine and the content visibility subsystem.
 *
 * Scoring heuristics:
 *   +3  per post
 *   +1  per comment
 *   +2  per vote
 *   +4  per pledge
 *   +5  per event created
 *   Age decay factor: score decays exponentially with a half-life of 14 days.
 *
 * Notes:
 *   – This service is intentionally stateless except for an L2 cache.
 *   – Uses Spring’s @Scheduled task to refresh hot scores periodically.
 *   – Exposes Micrometer counters for runtime observability.
 */
@Service
public class InfluenceScoreService {

    private static final Logger log = LoggerFactory.getLogger(InfluenceScoreService.class);

    // Scoring weights
    private static final Map<ActivityType, Integer> WEIGHTS = new EnumMap<>(ActivityType.class);
    static {
        WEIGHTS.put(ActivityType.POST_CREATE, 3);
        WEIGHTS.put(ActivityType.COMMENT_CREATE, 1);
        WEIGHTS.put(ActivityType.VOTE, 2);
        WEIGHTS.put(ActivityType.PLEDGE, 4);
        WEIGHTS.put(ActivityType.EVENT_CREATE, 5);
    }

    // Half-life for decay calculation (in milliseconds)
    private static final long HALF_LIFE_MILLIS = Duration.ofDays(14).toMillis();

    private final ActivityRepository activityRepository;
    private final CircleRepository circleRepository;
    private final UserRepository userRepository;
    private final CacheManager cacheManager;
    private final Counter computeCounter;
    private final Map<CacheKey, Instant> lastComputedAt = new ConcurrentHashMap<>();

    public InfluenceScoreService(ActivityRepository activityRepository,
                                 CircleRepository circleRepository,
                                 UserRepository userRepository,
                                 CacheManager cacheManager,
                                 MeterRegistry meterRegistry) {

        this.activityRepository = activityRepository;
        this.circleRepository = circleRepository;
        this.userRepository    = userRepository;
        this.cacheManager      = cacheManager;
        this.computeCounter    = meterRegistry.counter("analytics.influence_score.compute");
    }

    @PostConstruct
    private void onInit() {
        log.info("InfluenceScoreService up. Using L2 cache '{}'", cache().getName());
    }

    /**
     * Returns the cached influence score or computes it if absent or stale.
     *
     * @param circleId circle identifier
     * @param userId   user identifier
     * @return influence score between 0 and 100 (normalized)
     */
    @Transactional(readOnly = true)
    public double getInfluenceScore(long circleId, long userId) {
        CacheKey key = new CacheKey(circleId, userId);
        Double score = cache().get(key, Double.class);

        if (score == null || isStale(key)) {
            score = computeInfluenceScore(circleId, userId);
            cache().put(key, score);
            lastComputedAt.put(key, Instant.now());
        }
        return score;
    }

    /**
     * Scheduled refresh for top 1 000 active members per circle (hot cache).
     * Executes every 30 minutes by default.
     */
    @Scheduled(fixedRateString = "${nexus.analytics.influence.refresh-interval-ms:1800000}")
    public void refreshHotScores() {
        log.debug("Refreshing hot influence scores");
        circleRepository.findAllActiveCircleIds().forEach(circleId -> {
            List<Long> topUserIds = userRepository.findTopActiveUserIds(circleId, 1000);
            topUserIds.forEach(userId -> {
                try {
                    getInfluenceScore(circleId, userId);
                } catch (Exception e) {
                    log.warn("Unable to refresh influence score for user {} in circle {}: {}",
                             userId, circleId, e.getMessage());
                }
            });
        });
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    /**
     * Compute influence score from persistent activity data.
     */
    @Transactional(readOnly = true)
    protected double computeInfluenceScore(long circleId, long userId) {
        Circle circle = circleRepository.findById(circleId)
                                        .orElseThrow(() -> new ResourceNotFoundException("Circle not found: " + circleId));
        User user     = userRepository.findById(userId)
                                      .orElseThrow(() -> new ResourceNotFoundException("User not found: " + userId));

        computeCounter.increment();

        // Aggregate raw score
        long now = System.currentTimeMillis();
        long rawScore = activityRepository
            .findByCircleIdAndUserId(circleId, userId)
            .stream()
            .mapToLong(activity -> {
                int weight = WEIGHTS.getOrDefault(activity.getType(), 0);
                long ageMs = now - activity.getTimestamp().toEpochMilli();
                double decay = Math.pow(0.5, (double) ageMs / HALF_LIFE_MILLIS);
                return Math.round(weight * decay);
            })
            .sum();

        // Normalize to 0-100 range
        double normalized = normalize(rawScore, circle);

        log.debug("Computed influence score circle={} user={} raw={} normalized={}",
                  circleId, userId, rawScore, normalized);
        return normalized;
    }

    /**
     * Simple min-max normalization strategy.
     */
    private double normalize(long rawScore, Circle circle) {
        long maxRawScore = circle.getStats().getMaxRawInfluenceScore();
        long minRawScore = circle.getStats().getMinRawInfluenceScore();

        if (maxRawScore == minRawScore) {
            return 0; // avoid divide-by-zero; rare edge-case for brand-new circles
        }
        return 100.0 * (rawScore - minRawScore) / (maxRawScore - minRawScore);
    }

    private boolean isStale(CacheKey key) {
        Instant lastAt = lastComputedAt.get(key);
        return lastAt == null || lastAt.isBefore(Instant.now().minus(Duration.ofMinutes(15)));
    }

    private Cache cache() {
        Cache cache = cacheManager.getCache("influence-scores");
        if (cache == null) {
            throw new IllegalStateException("Cache 'influence-scores' is not configured");
        }
        return cache;
    }

    /**
     * Typed cache key wrapper to avoid accidental key collisions.
     */
    private record CacheKey(long circleId, long userId) { }

}